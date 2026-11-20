"""Ask your own AI (Claude / Gemini / ChatGPT) about course material.

Answers come from the AI command-line tools the host owner is logged into
(`claude`, Antigravity's `agy`, `codex`), so they run on personal
subscriptions — no API keys here. Two ways to reach them:

- LOCAL_MODE: the backend runs on the user's own computer and runs the CLIs itself.
- AI_BRIDGE_URL: the backend runs in Docker on a home server and calls
  scripts/ai_bridge.py on the host, which runs them (see INSTALL.md).

Who may use it: storage.ai_access (operator only, or everyone with AI_USERS=all).

  GET  /api/ai/providers   which CLIs are installed
  POST /api/ai/ask         {provider, question, selection?, path?, page?, history?}

The CLIs run with tools off (or read-only) in an empty temp dir: they only
see the prompt we build. Context is the text of the open file — for PDFs
just the pages around `page` — so a question costs a few thousand tokens.
"""
from __future__ import annotations

import asyncio
import base64
import os
import subprocess
from typing import Literal, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import ai_cli
from ..auth import require_user, User
from ..intents import files as files_intent
from ..schemas import EventCreate
from ..services import events as events_svc
from ..services import storage as storage_svc

router = APIRouter(prefix="/ai", tags=["ai"], dependencies=[Depends(require_user)])

Provider = Literal["claude", "gemini", "chatgpt"]
_MAX_CONTEXT_CHARS = 40_000  # ~10k tokens; bigger files need a page number


def _require_ai(user: User) -> None:
    if not storage_svc.ai_access(user.id):
        raise HTTPException(403, "Ask AI isn't enabled for this account: it runs on the host owner's AI subscriptions")


def _bridge_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {os.environ.get('AI_BRIDGE_SECRET', '').strip()}"}


async def _installed() -> dict[str, bool]:
    url = storage_svc.ai_bridge_url()
    if storage_svc.local_mode() or not url:
        return ai_cli.installed()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{url}/providers", headers=_bridge_headers())
        r.raise_for_status()
        return {pid: bool(r.json()["installed"].get(pid)) for pid in ai_cli.COMMANDS}
    except (httpx.HTTPError, KeyError, ValueError):
        return {pid: False for pid in ai_cli.COMMANDS}  # bridge down: UI shows "not installed"


@router.get("/providers")
async def providers(user: User = Depends(require_user)) -> dict:
    enabled = storage_svc.ai_access(user.id)
    installed = await _installed() if enabled else {pid: False for pid in ai_cli.COMMANDS}
    bridge = bool(storage_svc.ai_bridge_url()) and not storage_svc.local_mode()
    return {
        # False for accounts without AI access: the UI then hides Ask AI and the quiz.
        "ai_enabled": enabled,
        # Kept for older frontends; same meaning as ai_enabled.
        "local_mode": enabled,
        "providers": [
            {"id": pid, "installed": installed[pid],
             "hint": ai_cli.LOGIN_HINT[pid] + (" on the server PC" if bridge else "")}
            for pid in ai_cli.COMMANDS
        ],
    }


@router.get("/models")
async def models(user: User = Depends(require_user)) -> dict:
    """{provider: [{id, label}]} for the model picker ("" = the CLI's default)."""
    _require_ai(user)
    url = storage_svc.ai_bridge_url()
    if url and not storage_svc.local_mode():
        try:
            async with httpx.AsyncClient(timeout=90) as client:
                r = await client.get(f"{url}/models", headers=_bridge_headers())
            r.raise_for_status()
            raw = r.json()["models"]
        except (httpx.HTTPError, KeyError, ValueError):
            raw = {}
    else:
        installed = ai_cli.installed()
        raw = {pid: await asyncio.to_thread(ai_cli.models, pid) for pid in ai_cli.COMMANDS if installed[pid]}
    return {pid: [{"id": m[0], "label": m[1]} for m in lst] for pid, lst in raw.items()}


class Turn(BaseModel):
    question: str = Field(max_length=4000)
    answer: str = Field(max_length=20000)


class AskBody(BaseModel):
    provider: Provider
    question: str = Field(min_length=1, max_length=4000)
    selection: Optional[str] = Field(default=None, max_length=20000)
    path: Optional[str] = Field(default=None, max_length=1000)
    page: Optional[int] = Field(default=None, ge=1)
    history: list[Turn] = Field(default_factory=list, max_length=20)


def _pdf_text(data: bytes, page: Optional[int]) -> str:
    import fitz  # pymupdf

    with fitz.open(stream=data, filetype="pdf") as doc:
        first, last = (max(page - 1, 1), min(page + 1, doc.page_count)) if page else (1, doc.page_count)
        return "\n\n".join(
            f"[page {i}]\n{doc[i - 1].get_text()}" for i in range(first, last + 1)
        )


async def _material(user: User, path: str, page: Optional[int]) -> str:
    try:
        data = await files_intent.download(user.id, path)
    except Exception as exc:
        raise HTTPException(404, f"can't read {path}: {exc}") from exc
    if path.lower().endswith(".pdf"):
        text = await asyncio.to_thread(_pdf_text, data, page)
    else:
        text = data.decode("utf-8", errors="replace")
    if len(text) > _MAX_CONTEXT_CHARS:
        text = text[:_MAX_CONTEXT_CHARS] + "\n[…truncated — ask about a specific page to see the rest]"
    return text


def _prompt(body: AskBody, material: Optional[str]) -> str:
    parts = [
        "You are a study assistant inside OpenStudy, a student's course dashboard. "
        "Answer clearly and concisely, in the language of the question. "
        "Use the course material below when relevant and say so if it doesn't cover the question."
    ]
    if material is not None:
        where = f" (around page {body.page})" if body.page else ""
        parts.append(f'<material file="{body.path}"{where}>\n{material}\n</material>')
    if body.selection:
        parts.append(f"<selected_text>\n{body.selection}\n</selected_text>")
    for turn in body.history:
        parts.append(f"<previous_question>{turn.question}</previous_question>\n<previous_answer>{turn.answer}</previous_answer>")
    parts.append(f"Question: {body.question}")
    return "\n\n".join(parts)


Images = list[tuple[str, bytes]]


async def _run_bridge(url: str, provider: str, prompt: str, model: str, images: Images) -> tuple[int, str, str]:
    payload = {"provider": provider, "prompt": prompt, "model": model,
               "images": [{"mime": m, "data": base64.b64encode(d).decode()} for m, d in images]}
    try:
        async with httpx.AsyncClient(timeout=ai_cli.TIMEOUT_S + 30) as client:
            r = await client.post(f"{url}/run", json=payload, headers=_bridge_headers())
    except httpx.TimeoutException as exc:
        raise HTTPException(504, "the AI took longer than 5 minutes") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, "the AI bridge on the server PC isn't answering — is scripts/ai_bridge.py running?") from exc
    if r.status_code == 504:
        raise HTTPException(504, "the AI took longer than 5 minutes")
    data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200:
        raise HTTPException(400 if data.get("error") in ("missing", "invalid") else 502,
                            data.get("message") or f"AI bridge error: {data.get('error') or r.status_code}")
    return int(data.get("returncode", 1)), data.get("stdout") or "", data.get("stderr") or ""


async def _run_local(provider: str, prompt: str, model: str, images: Images) -> tuple[int, str, str]:
    try:
        proc = await asyncio.to_thread(ai_cli.run, provider, prompt, model, images)
    except (ai_cli.CliMissing, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, "the AI took longer than 5 minutes") from exc
    return proc.returncode, proc.stdout, proc.stderr


async def run_ai(provider: str, prompt: str, user: User, model: str = "", images: Images | None = None) -> str:
    """Run `prompt` (+ pasted images) through the provider's CLI and return its
    answer (HTTP errors on failure). `model` "" = the CLI's default."""
    _require_ai(user)
    url = storage_svc.ai_bridge_url()
    if url and not storage_svc.local_mode():
        code, stdout, stderr = await _run_bridge(url, provider, prompt, model, images or [])
    else:
        code, stdout, stderr = await _run_local(provider, prompt, model, images or [])
    answer = stdout.strip()
    if code != 0 or not answer:
        lines = (stderr or stdout).strip().splitlines()
        # Drop CLI warnings and agy's raw JSON echo of the same error.
        err = [ln for ln in lines if not ln.lower().startswith(("warning", "agy_error"))][-3:] or lines[-3:]
        needs_login = any(w in " ".join(err).lower() for w in ("auth", "login", "log in", "sign in"))
        hint = f" — {ai_cli.LOGIN_HINT[provider]}" if needs_login else ""
        raise HTTPException(502, f"{provider} failed: {' / '.join(err) or 'no output'}{hint}")
    return answer


@router.post("/ask")
async def ask(body: AskBody, user: User = Depends(require_user)) -> dict:
    _require_ai(user)
    material = await _material(user, body.path, body.page) if body.path else None
    answer = await run_ai(body.provider, _prompt(body, material), user)
    # Logged so the daily quiz knows what you asked about (question only, not the answer).
    await events_svc.record_event(user.id, EventCreate(
        kind="ai:ask",
        course_code=storage_svc._course_code_from_path(body.path),
        payload={"question": body.question, "path": body.path, "provider": body.provider},
    ))
    return {"answer": answer}
