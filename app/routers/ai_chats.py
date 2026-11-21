"""Saved, shared Ask AI conversations.

Every account with AI access (storage.ai_access) sees and can continue every
chat: one common list for the people sharing this instance's AI
subscriptions. Tables: migrations/20261120000001_ai_chats.sql.

  GET    /api/ai/chats                  list (newest first)
  POST   /api/ai/chats                  {title?} → new chat
  GET    /api/ai/chats/{id}             chat + messages
  PATCH  /api/ai/chats/{id}             {title}
  DELETE /api/ai/chats/{id}
  POST   /api/ai/chats/{id}/messages    {provider, model?, question, selection?, path?, page?, images?}
  GET    /api/ai/images/{id}            a pasted image

Sending stores the question first (so the other person sees it while the AI
thinks), then the answer — or an `error` message if the AI failed.
"""
from __future__ import annotations

import base64
import binascii
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import ai_cli, db
from ..auth import require_user, User
from ..schemas import EventCreate
from ..services import events as events_svc
from ..services import storage as storage_svc
from .ai import Provider, _material, run_ai

router = APIRouter(prefix="/ai", tags=["ai"], dependencies=[Depends(require_user)])

_HISTORY_TURNS = 20           # earlier messages sent along with a new question
_HISTORY_ANSWER_CHARS = 6000  # long earlier answers are cut to this
PENDING_FOR = timedelta(seconds=ai_cli.TIMEOUT_S + 60)

FORMAT_NOTE = (
    "Format the answer in Markdown (headings, **bold**, lists, tables, code blocks where useful). "
    "Write all math in LaTeX: $...$ inline and $$...$$ on its own lines for display formulas."
)


def _require_ai(user: User) -> None:
    if not storage_svc.ai_access(user.id):
        raise HTTPException(403, "Ask AI isn't enabled for this account")


async def _chat_or_404(chat_id: UUID) -> dict[str, Any]:
    row = await db.fetchrow("SELECT id, title, created_by, created_at, updated_at FROM ai_chats WHERE id = %s", str(chat_id))
    if row is None:
        raise HTTPException(404, "chat not found")
    return row


@router.get("/chats")
async def list_chats(user: User = Depends(require_user)) -> list[dict[str, Any]]:
    _require_ai(user)
    return await db.fetch(
        """SELECT c.id, c.title, c.updated_at, u.display_name AS created_by_name,
                  (SELECT count(*) FROM ai_chat_messages m WHERE m.chat_id = c.id) AS messages
           FROM ai_chats c LEFT JOIN users u ON u.id = c.created_by
           ORDER BY c.updated_at DESC LIMIT 200"""
    )


class ChatCreate(BaseModel):
    title: str = Field(default="", max_length=200)


@router.post("/chats")
async def create_chat(body: ChatCreate, user: User = Depends(require_user)) -> dict[str, Any]:
    _require_ai(user)
    return await db.fetchrow(
        "INSERT INTO ai_chats (title, created_by) VALUES (%s, %s) RETURNING id, title, created_at, updated_at",
        body.title.strip(), str(user.id),
    )


async def _messages(chat_id: UUID) -> list[dict[str, Any]]:
    rows = await db.fetch(
        """SELECT m.id, m.role, m.content, m.provider, m.model, m.context, m.created_at,
                  m.author, u.display_name AS author_name,
                  COALESCE((SELECT array_agg(i.id ORDER BY i.created_at) FROM ai_chat_images i
                            WHERE i.message_id = m.id), '{}') AS images
           FROM ai_chat_messages m LEFT JOIN users u ON u.id = m.author
           WHERE m.chat_id = %s ORDER BY m.id""",
        str(chat_id),
    )
    for r in rows:
        r["images"] = [str(i) for i in r["images"]]
    return rows


@router.get("/chats/{chat_id}")
async def get_chat(chat_id: UUID, user: User = Depends(require_user)) -> dict[str, Any]:
    _require_ai(user)
    chat = await _chat_or_404(chat_id)
    msgs = await _messages(chat_id)
    last = msgs[-1] if msgs else None
    # A question without an answer yet: someone's AI call is still running.
    pending = bool(last and last["role"] == "user"
                   and datetime.now(timezone.utc) - last["created_at"] < PENDING_FOR)
    return {**chat, "messages": msgs, "pending": pending}


class ChatPatch(BaseModel):
    title: str = Field(max_length=200)


@router.patch("/chats/{chat_id}")
async def rename_chat(chat_id: UUID, body: ChatPatch, user: User = Depends(require_user)) -> dict[str, Any]:
    _require_ai(user)
    await _chat_or_404(chat_id)
    await db.execute("UPDATE ai_chats SET title = %s WHERE id = %s", body.title.strip(), str(chat_id))
    return {"ok": True}


@router.delete("/chats/{chat_id}")
async def delete_chat(chat_id: UUID, user: User = Depends(require_user)) -> dict[str, Any]:
    _require_ai(user)
    await _chat_or_404(chat_id)
    await db.execute("DELETE FROM ai_chats WHERE id = %s", str(chat_id))
    return {"ok": True}


class ImageIn(BaseModel):
    mime: str = Field(max_length=40)
    data: str = Field(max_length=7_000_000)  # base64 of ≤ 5 MB


class MessageIn(BaseModel):
    provider: Provider
    model: str = Field(default="", max_length=80)
    question: str = Field(min_length=1, max_length=8000)
    selection: Optional[str] = Field(default=None, max_length=20000)
    path: Optional[str] = Field(default=None, max_length=1000)
    page: Optional[int] = Field(default=None, ge=1)
    images: list[ImageIn] = Field(default_factory=list, max_length=ai_cli.MAX_IMAGES)
    # Let the AI read this course folder (top-level folder name; claude only).
    course: Optional[str] = Field(default=None, max_length=200)


def _decode_images(images: list[ImageIn]) -> list[tuple[str, bytes]]:
    out = []
    for img in images:
        if img.mime not in ai_cli.IMAGE_TYPES:
            raise HTTPException(400, "images must be PNG, JPEG, GIF or WebP")
        try:
            data = base64.b64decode(img.data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(400, "invalid image data") from exc
        if not data or len(data) > ai_cli.MAX_IMAGE_BYTES:
            raise HTTPException(400, "images can be at most 5 MB each")
        out.append((img.mime, data))
    return out


def build_prompt(history: list[dict[str, Any]], material: Optional[str], ctx: dict[str, Any],
                 question: str, asker: str, n_images: int) -> str:
    """The prompt for one turn: instructions, the open file / selection, the
    earlier turns (with who asked, since chats are shared), then the question."""
    parts = [
        "You are a study assistant inside OpenStudy, a course dashboard shared by a few students. "
        "Answer clearly, in the language of the question. Use the course material below when relevant "
        "and say so if it doesn't cover the question. " + FORMAT_NOTE
    ]
    if material is not None:
        where = f" (around page {ctx['page']})" if ctx.get("page") else ""
        parts.append(f'<material file="{ctx.get("path")}"{where}>\n{material}\n</material>')
    if ctx.get("selection"):
        parts.append(f"<selected_text>\n{ctx['selection']}\n</selected_text>")
    turns = [m for m in history if m["role"] in ("user", "assistant")][-_HISTORY_TURNS:]
    for m in turns:
        if m["role"] == "user":
            pics = f" [+{len(m['images'])} image(s), not resent]" if m.get("images") else ""
            parts.append(f'<previous_question by="{m.get("author_name") or "someone"}">{m["content"]}{pics}</previous_question>')
        else:
            text = m["content"]
            if len(text) > _HISTORY_ANSWER_CHARS:
                text = text[:_HISTORY_ANSWER_CHARS] + " […]"
            parts.append(f"<previous_answer>{text}</previous_answer>")
    pics = f" ({n_images} image(s) attached)" if n_images else ""
    parts.append(f"Question from {asker}{pics}: {question}")
    return "\n\n".join(parts)


@router.post("/chats/{chat_id}/messages")
async def send_message(chat_id: UUID, body: MessageIn, user: User = Depends(require_user)) -> dict[str, Any]:
    _require_ai(user)
    chat = await _chat_or_404(chat_id)
    images = _decode_images(body.images)
    history = await _messages(chat_id)

    # The file / selection this question is about; a follow-up without one
    # keeps talking about the last one in the chat.
    ctx = {k: v for k, v in {"path": body.path, "page": body.page, "selection": body.selection}.items() if v}
    if not ctx:
        ctx = next((m["context"] for m in reversed(history) if m["role"] == "user" and m.get("context")), {}) or {}
    material = await _material(user, ctx["path"], ctx.get("page")) if ctx.get("path") else None

    async with db.db() as conn, conn.transaction(), conn.cursor() as cur:
        await cur.execute(
            """INSERT INTO ai_chat_messages (chat_id, role, content, author, provider, model, context)
               VALUES (%s, 'user', %s, %s, %s, %s, %s) RETURNING id""",
            (str(chat_id), body.question, str(user.id), body.provider, body.model or None,
             Jsonb(ctx) if (body.path or body.page or body.selection) else None),
        )
        question_id = (await cur.fetchone())["id"]
        for mime, data in images:
            await cur.execute("INSERT INTO ai_chat_images (message_id, mime, data) VALUES (%s, %s, %s)",
                              (question_id, mime, data))
        title = chat["title"] or body.question.strip().splitlines()[0][:80]
        await cur.execute("UPDATE ai_chats SET updated_at = now(), title = %s WHERE id = %s", (title, str(chat_id)))

    prompt = build_prompt(history, material, ctx, body.question, user.display_name or "the student", len(images))
    try:
        # course "" = the user switched course access off; None = use the course
        # of the file this chat is about (its first path segment), if any.
        if body.course == "":
            course = None
        else:
            ctx_path = ctx.get("path") or ""
            course = body.course or (ctx_path.split("/")[0] if "/" in ctx_path else None)
        answer, role = await run_ai(body.provider, prompt, user, body.model, images, course), "assistant"
    except HTTPException as exc:
        answer, role = str(exc.detail), "error"
    await db.execute(
        """INSERT INTO ai_chat_messages (chat_id, role, content, author, provider, model)
           VALUES (%s, %s, %s, NULL, %s, %s)""",
        str(chat_id), role, answer, body.provider, body.model or None,
    )
    await db.execute("UPDATE ai_chats SET updated_at = now() WHERE id = %s", str(chat_id))
    # Logged so the daily quiz knows what you asked about (question only, not the answer).
    await events_svc.record_event(user.id, EventCreate(
        kind="ai:ask",
        course_code=storage_svc._course_code_from_path(ctx.get("path")),
        payload={"question": body.question, "path": ctx.get("path"), "provider": body.provider},
    ))
    return await get_chat(chat_id, user)


@router.get("/images/{image_id}")
async def get_image(image_id: UUID, user: User = Depends(require_user)) -> Response:
    _require_ai(user)
    row = await db.fetchrow("SELECT mime, data FROM ai_chat_images WHERE id = %s", str(image_id))
    if row is None or row["mime"] not in ai_cli.IMAGE_TYPES:
        raise HTTPException(404, "image not found")
    return Response(
        content=bytes(row["data"]), media_type=row["mime"],
        headers={"Cache-Control": "private, max-age=86400, immutable", "X-Content-Type-Options": "nosniff"},
    )
