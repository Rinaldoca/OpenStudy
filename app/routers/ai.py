"""Ask your own AI (Claude / Gemini / ChatGPT) about course material.

LOCAL_MODE only: the backend runs on the user's Mac and shells out to the
AI CLIs they're already logged into (`claude`, Antigravity's `agy`, `codex`), so
answers come from their personal subscriptions — no API keys here.

  GET  /api/ai/providers   which CLIs are installed
  POST /api/ai/ask         {provider, question, selection?, path?, page?, history?}

The CLIs run with tools off (or read-only) in an empty temp dir: they only
see the prompt we build. Context is the text of the open file — for PDFs
just the pages around `page` — so a question costs a few thousand tokens.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_user, User
from ..intents import files as files_intent
from ..schemas import EventCreate
from ..services import events as events_svc
from ..services import storage as storage_svc

router = APIRouter(prefix="/ai", tags=["ai"], dependencies=[Depends(require_user)])

Provider = Literal["claude", "gemini", "chatgpt"]

# provider → (binary, args). The prompt goes in on stdin, or replaces "{prompt}"
# for CLIs that only take it as an argument (prompts stay far below macOS's 1 MB ARG_MAX).
_COMMANDS: dict[str, tuple[str, list[str]]] = {
    # --safe-mode: skip the user's plugins/hooks/CLAUDE.md (they leak into answers); keeps their login.
    "claude": ("claude", ["-p", "--safe-mode", "--tools", "","--no-session-persistence", "--strict-mcp-config"]),
    # Antigravity CLI (replaced the old `gemini` CLI). Plan mode = read-only.
    "gemini": ("agy", ["--mode", "plan", "--print-timeout", "280s", "-p={prompt}"]),
    # ponytail: codex flags from its docs, not run here (codex wasn't installed when written).
    "chatgpt": ("codex", ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "-"]),
}
_LOGIN_HINT = {
    "claude": "run `claude` in Terminal once and log in",
    "gemini": "install Antigravity, then run `agy` in Terminal once and sign in with Google",
    "chatgpt": "install with `npm i -g @openai/codex`, then run `codex` once and sign in with ChatGPT",
}
_MAX_CONTEXT_CHARS = 40_000  # ~10k tokens; bigger files need a page number


def _search_path() -> str:
    # The server may start with a minimal PATH; add where npm/brew put CLIs.
    home = Path.home()
    extra = [home / ".npm-global/bin", home / ".local/bin", home / ".volta/bin", Path("/opt/homebrew/bin"), Path("/usr/local/bin")]
    return os.pathsep.join([os.environ.get("PATH", ""), *map(str, extra)])


def _require_local() -> None:
    if not storage_svc.local_mode():
        raise HTTPException(403, "AI needs LOCAL_MODE=true (backend running on your own Mac)")


@router.get("/providers")
async def providers() -> dict:
    path = _search_path()
    return {
        "local_mode": storage_svc.local_mode(),
        "providers": [
            {"id": pid, "installed": shutil.which(binary, path=path) is not None, "hint": _LOGIN_HINT[pid]}
            for pid, (binary, _) in _COMMANDS.items()
        ],
    }


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


def _run(provider: str, prompt: str) -> subprocess.CompletedProcess:
    binary, args = _COMMANDS[provider]
    path = _search_path()
    exe = shutil.which(binary, path=path)
    if not exe:
        raise HTTPException(400, f"{binary} isn't installed — {_LOGIN_HINT[provider]}")
    as_arg = "-p={prompt}" in args
    argv = [exe, *(a.replace("{prompt}", prompt) for a in args)]
    # Empty cwd: the CLI sees nothing but the prompt.
    with tempfile.TemporaryDirectory(prefix="openstudy-ai-") as cwd:
        return subprocess.run(
            argv, input=None if as_arg else prompt, stdin=subprocess.DEVNULL if as_arg else None,
            capture_output=True, text=True,
            cwd=cwd, env={**os.environ, "PATH": path}, timeout=300,
        )


async def run_ai(provider: str, prompt: str) -> str:
    """Run `prompt` through the provider's CLI and return its answer (HTTP errors on failure)."""
    _require_local()
    try:
        proc = await asyncio.to_thread(_run, provider, prompt)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, "the AI took longer than 5 minutes") from exc
    answer = proc.stdout.strip()
    if proc.returncode != 0 or not answer:
        lines = (proc.stderr or proc.stdout).strip().splitlines()
        # Drop CLI warnings and agy's raw JSON echo of the same error.
        err = [ln for ln in lines if not ln.lower().startswith(("warning", "agy_error"))][-3:] or lines[-3:]
        needs_login = any(w in " ".join(err).lower() for w in ("auth", "login", "log in", "sign in"))
        hint = f" — {_LOGIN_HINT[provider]}" if needs_login else ""
        raise HTTPException(502, f"{provider} failed: {' / '.join(err) or 'no output'}{hint}")
    return answer


@router.post("/ask")
async def ask(body: AskBody, user: User = Depends(require_user)) -> dict:
    _require_local()
    material = await _material(user, body.path, body.page) if body.path else None
    answer = await run_ai(body.provider, _prompt(body, material))
    # Logged so the daily quiz knows what you asked about (question only, not the answer).
    await events_svc.record_event(user.id, EventCreate(
        kind="ai:ask",
        course_code=storage_svc._course_code_from_path(body.path),
        payload={"question": body.question, "path": body.path, "provider": body.provider},
    ))
    return {"answer": answer}
