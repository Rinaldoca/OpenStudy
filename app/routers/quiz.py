"""Daily recap quiz, written and graded by the user's own AI (LOCAL_MODE).

  POST /api/ai/quiz/generate  {provider, course?, notes?, count?} → questions
  POST /api/ai/quiz/grade     {provider, questions, answers}       → feedback + gaps

"Today" is gathered from what OpenStudy already records, in the user's
timezone: lectures held today, study topics covered/reviewed/edited today,
files opened today (activity log) and questions asked in Ask AI today —
plus free-text notes the user adds. Nothing is stored; a quiz lives in the
page until it's graded.
"""
from __future__ import annotations

import json
from datetime import datetime, time
from typing import Literal, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError

from ..auth import require_user, User
from ..services import events as events_svc
from ..services import lectures as lectures_svc
from ..services import settings as settings_svc
from ..services import study_topics as topics_svc
from .ai import Provider, _material, run_ai

router = APIRouter(prefix="/ai/quiz", tags=["ai"], dependencies=[Depends(require_user)])

_FILE_EVENTS = ("storage:sign", "storage:read")  # opened in the viewer / read by Ask AI
_MAX_FILES = 4
_CHARS_PER_FILE = 8_000  # ~2k tokens each


class QuizQuestion(BaseModel):
    id: int
    type: Literal["mcq", "short"]
    question: str
    options: list[str] = Field(default_factory=list)
    answer: str
    topic: str = ""


class GenerateBody(BaseModel):
    provider: Provider
    course: Optional[str] = Field(default=None, max_length=50)
    notes: Optional[str] = Field(default=None, max_length=5000)
    count: int = Field(default=6, ge=3, le=15)


class GradeBody(BaseModel):
    provider: Provider
    questions: list[QuizQuestion] = Field(min_length=1, max_length=15)
    answers: list[str] = Field(max_length=15)


def _parse_json(text: str) -> dict:
    """The CLIs answer in prose; take the outermost {...} block."""
    try:
        return json.loads(text[text.index("{"): text.rindex("}") + 1])
    except ValueError as exc:  # no braces, or invalid JSON
        raise HTTPException(502, "the AI didn't return a valid quiz — try again") from exc


async def _today(user: User, course: Optional[str]) -> dict:
    tz = ZoneInfo((await settings_svc.get_settings(user.id)).timezone or "UTC")
    today = datetime.now(tz).date()
    start = datetime.combine(today, time.min, tz)

    def is_today(ts: Optional[datetime]) -> bool:
        return bool(ts) and ts.astimezone(tz).date() == today

    lectures = [lec for lec in await lectures_svc.list_lectures(user.id, course) if lec.held_on == today]
    topics = [
        t for t in await topics_svc.list_study_topics(user.id, course)
        if t.covered_on == today or is_today(t.last_reviewed_at) or is_today(t.updated_at)
    ]
    events = await events_svc.list_events(user.id, since=start, limit=500)
    if course:
        events = [e for e in events if e.course_code == course]
    files: list[str] = []
    for e in events:  # newest first
        path = (e.payload or {}).get("path")
        if e.kind in _FILE_EVENTS and path and not path.endswith(".keep") and path not in files:
            files.append(path)
    asked = [e.payload["question"] for e in events if e.kind == "ai:ask" and (e.payload or {}).get("question")]
    return {"date": today.isoformat(), "lectures": lectures, "topics": topics, "files": files[:_MAX_FILES], "asked": asked}


async def _context_text(user: User, ctx: dict, notes: Optional[str]) -> str:
    parts: list[str] = []
    for lec in ctx["lectures"]:
        parts.append(f"<lecture course=\"{lec.course_code}\" number=\"{lec.number}\">\n{lec.title or ''}\n{lec.summary or ''}\n{lec.notes or ''}\n</lecture>")
    for t in ctx["topics"]:
        parts.append(f"<study_topic course=\"{t.course_code}\" status=\"{t.status}\">\n{t.chapter or ''} {t.name}\n{t.description or ''}\n{t.notes or ''}\n</study_topic>")
    for path in ctx["files"]:
        try:
            text = (await _material(user, path, None))[:_CHARS_PER_FILE]
        except HTTPException:
            continue  # deleted/moved since
        parts.append(f"<file path=\"{path}\">\n{text}\n</file>")
    if ctx["asked"]:
        parts.append("<questions_the_student_asked>\n" + "\n".join(f"- {q}" for q in ctx["asked"]) + "\n</questions_the_student_asked>")
    if notes:
        parts.append(f"<student_notes>\n{notes}\n</student_notes>")
    return "\n\n".join(parts)


@router.post("/generate")
async def generate(body: GenerateBody, user: User = Depends(require_user)) -> dict:
    ctx = await _today(user, body.course)
    material = await _context_text(user, ctx, body.notes)
    if not material:
        raise HTTPException(400, "nothing recorded for today yet — write what you studied in the notes box")
    prompt = f"""You are a tutor writing a short recap quiz for a university student about what they studied today ({ctx['date']}).
Base every question ONLY on the material below. Test understanding, not trivia. Mix multiple-choice and short-answer questions.

{material}

Write exactly {body.count} questions. Reply with ONLY this JSON, no prose, no code fences:
{{"title": "<short quiz title>", "questions": [
  {{"id": 1, "type": "mcq", "question": "...", "options": ["...", "...", "...", "..."], "answer": "<the correct option, verbatim>", "topic": "<topic it tests>"}},
  {{"id": 2, "type": "short", "question": "...", "answer": "<model answer, 1-3 sentences>", "topic": "..."}}
]}}
Write in the language of the material."""
    data = _parse_json(await run_ai(body.provider, prompt))
    questions = []
    for q in data.get("questions") or []:
        try:
            questions.append(QuizQuestion.model_validate(q))
        except ValidationError:
            continue  # skip a malformed question rather than fail the quiz
    if not questions:
        raise HTTPException(502, "the AI didn't return any usable questions — try again")
    return {
        "title": str(data.get("title") or "Today's recap"),
        "questions": [q.model_dump() for q in questions],
        "sources": {
            "lectures": [lec.title or f"{lec.course_code} #{lec.number}" for lec in ctx["lectures"]],
            "topics": [t.name for t in ctx["topics"]],
            "files": ctx["files"],
            "asked": len(ctx["asked"]),
            "notes": bool(body.notes),
        },
    }


@router.post("/grade")
async def grade(body: GradeBody) -> dict:
    answers = body.answers + [""] * (len(body.questions) - len(body.answers))
    items = "\n\n".join(
        f"<q id=\"{q.id}\" type=\"{q.type}\" topic=\"{q.topic}\">\nQuestion: {q.question}\n"
        + (f"Options: {' | '.join(q.options)}\n" if q.options else "")
        + f"Expected: {q.answer}\nStudent: {a or '(no answer)'}\n</q>"
        for q, a in zip(body.questions, answers)
    )
    prompt = f"""You are a supportive but honest tutor grading a student's recap quiz.
For short answers, accept anything that shows the right understanding even if worded differently.

{items}

Reply with ONLY this JSON, no prose, no code fences:
{{"results": [{{"id": 1, "correct": true, "feedback": "<one or two sentences: why, and the key idea if wrong>"}}],
 "summary": "<2-3 sentences on how today went>",
 "gaps": ["<concept the student is missing or shaky on>"],
 "next_steps": ["<concrete thing to review or practice>"]}}
Write in the language of the questions."""
    data = _parse_json(await run_ai(body.provider, prompt))
    results = [
        {"id": int(r.get("id", 0)), "correct": bool(r.get("correct")), "feedback": str(r.get("feedback", ""))}
        for r in data.get("results") or [] if isinstance(r, dict)
    ]
    return {
        "results": results,
        "score": sum(r["correct"] for r in results),
        "total": len(body.questions),
        "summary": str(data.get("summary", "")),
        "gaps": [str(g) for g in data.get("gaps") or []],
        "next_steps": [str(s) for s in data.get("next_steps") or []],
    }
