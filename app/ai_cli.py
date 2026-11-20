"""Run the AI CLIs (Claude Code, Antigravity, Codex) on a prompt.

Standard library only: it is imported by app/routers/ai.py (when the backend
itself runs on the user's computer, LOCAL_MODE) and by scripts/ai_bridge.py
(a tiny service on the host that the Docker backend calls, so the CLIs run
with the host owner's logins — see INSTALL.md → "Ask AI on a home server").

The CLIs run with tools off (or read-only) in an empty temp dir: they only
see the prompt we build.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# provider → (binary, args). The prompt goes in on stdin, or replaces "{prompt}"
# for CLIs that only take it as an argument.
COMMANDS: dict[str, tuple[str, list[str]]] = {
    # --safe-mode: skip the user's plugins/hooks/CLAUDE.md (they leak into answers); keeps their login.
    "claude": ("claude", ["-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--strict-mcp-config"]),
    # Antigravity CLI (replaced the old `gemini` CLI). Plan mode = read-only.
    "gemini": ("agy", ["--mode", "plan", "--print-timeout", "280s", "-p={prompt}"]),
    # ponytail: codex flags from its docs, not run here (codex wasn't installed when written).
    "chatgpt": ("codex", ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "-"]),
}
LOGIN_HINT = {
    "claude": "run `claude` in a terminal once and log in",
    "gemini": "install Antigravity's CLI, then run `agy` in a terminal once and sign in with Google",
    "chatgpt": "install with `npm i -g @openai/codex`, then run `codex` once and sign in with ChatGPT",
}
TIMEOUT_S = 300

# agy is an agent even in plan mode: in an empty folder it tends to reach for a
# shell command first, headless mode denies it, and it ends with no answer. The
# prompt already holds everything it needs, so tell it so. (claude runs with
# --tools "" and needs no such note.)
NO_TOOLS_NOTE = {
    "gemini": "Answer directly from the text below. Do not use any tools, run any commands or read any files.\n\n",
}

# Windows caps a whole command line at 32,767 characters; macOS/Linux allow ~1 MB.
# Prompts passed as an argument (agy) are cut to fit, keeping the question at the end.
_MAX_ARG_PROMPT = 24_000 if sys.platform == "win32" else 500_000


class CliMissing(Exception):
    """The provider's CLI isn't installed on this machine."""


def search_path() -> str:
    # The server may start with a minimal PATH; add where npm/brew/installers put CLIs.
    home = Path.home()
    extra = [home / ".npm-global/bin", home / ".local/bin", home / ".volta/bin",
             Path("/opt/homebrew/bin"), Path("/usr/local/bin")]
    if sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA", home / "AppData/Roaming"))
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData/Local"))
        # agy's Windows installer (irm https://antigravity.google/cli/install.ps1 | iex) puts it in
        # %LOCALAPPDATA%/agy/bin. Not Antigravity's desktop-app folders: those only hold the IDE.
        extra += [appdata / "npm", local / "agy/bin"]
    return os.pathsep.join([os.environ.get("PATH", ""), *map(str, extra)])


def installed() -> dict[str, bool]:
    path = search_path()
    return {pid: shutil.which(binary, path=path) is not None for pid, (binary, _) in COMMANDS.items()}


def _fit_arg(prompt: str) -> str:
    if len(prompt) <= _MAX_ARG_PROMPT:
        return prompt
    head, sep, question = prompt.rpartition("\n\nQuestion: ")
    tail = f"{sep}{question}" if sep else ""
    keep = _MAX_ARG_PROMPT - len(tail) - 60
    return head[:max(keep, 0)] + "\n[…material truncated to fit]" + tail


# Pasted images: claude takes them inline (stream-json content blocks); agy's
# stream input is text-only, so they're saved into its empty working folder and
# it may open them with view_file and nothing else (run_command stays denied).
IMAGE_NOTE = (
    "The user attached {n} image(s), saved in the current folder as {names}. Open them with "
    "view_file and answer using them and the text below. Do not run any commands or open other files.\n\n"
)
_AGY_IMAGE_SETTINGS = '{"permissions": {"allow": ["view_file(*)"], "deny": ["command(*)", "run_command(*)"]}}'
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
MAX_IMAGE_BYTES = 5_000_000
MAX_IMAGES = 6

# Offered in the model picker. claude takes aliases; agy's list comes from `agy models`.
CLAUDE_MODELS = [("", "Default"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")]
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
_models_cache: dict[str, tuple[float, list[tuple[str, str]]]] = {}


def models(provider: str) -> list[tuple[str, str]]:
    """[(id, label)] for the model picker; "" = the CLI's own default."""
    if provider == "claude":
        return CLAUDE_MODELS
    if provider != "gemini":
        return [("", "Default")]
    hit = _models_cache.get(provider)
    if hit and time.monotonic() - hit[0] < 600:
        return hit[1]
    out = [("", "Default")]
    exe = shutil.which("agy", path=search_path())
    if exe:
        try:
            proc = subprocess.run([exe, "models"], capture_output=True, text=True, encoding="utf-8",
                                  errors="replace", timeout=60, env={**os.environ, "PATH": search_path()})
            for line in proc.stdout.splitlines():
                mid, _, label = line.partition("\t")
                if _MODEL_RE.match(mid.strip()):
                    out.append((mid.strip(), label.strip() or mid.strip()))
        except (OSError, subprocess.TimeoutExpired):
            pass
    _models_cache[provider] = (time.monotonic(), out)
    return out


def _claude_stream_input(prompt: str, images: list[tuple[str, bytes]]) -> str:
    content = [{"type": "image", "source": {"type": "base64", "media_type": mime,
                                            "data": base64.b64encode(data).decode()}}
               for mime, data in images]
    content.append({"type": "text", "text": prompt})
    return json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n"


def _claude_stream_result(proc: subprocess.CompletedProcess) -> subprocess.CompletedProcess:
    """Turn claude's stream-json output back into plain stdout/stderr."""
    for line in reversed(proc.stdout.splitlines()):
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "result":
            text = str(event.get("result") or "")
            if event.get("is_error"):
                return subprocess.CompletedProcess(proc.args, proc.returncode or 1, "", text or proc.stderr)
            return subprocess.CompletedProcess(proc.args, 0, text, proc.stderr)
    return subprocess.CompletedProcess(proc.args, proc.returncode or 1, "", proc.stderr or proc.stdout[-2000:])


def run(provider: str, prompt: str, model: str = "",
        images: list[tuple[str, bytes]] | None = None) -> subprocess.CompletedProcess:
    """Run `prompt` (plus optional pasted images as (mime, bytes)) through the
    provider's CLI. Raises CliMissing, ValueError (bad model/image), KeyError
    (unknown provider) or subprocess.TimeoutExpired."""
    binary, args = COMMANDS[provider]
    images = images or []
    if model and not _MODEL_RE.match(model):
        raise ValueError("invalid model name")
    if len(images) > MAX_IMAGES or any(m not in IMAGE_TYPES or len(d) > MAX_IMAGE_BYTES for m, d in images):
        raise ValueError(f"up to {MAX_IMAGES} PNG/JPEG/GIF/WebP images, 5 MB each")
    if images and provider not in ("claude", "gemini"):
        raise ValueError(f"{provider} can't take images here")
    path = search_path()
    exe = shutil.which(binary, path=path)
    if not exe:
        raise CliMissing(f"{binary} isn't installed — {LOGIN_HINT[provider]}")
    names = [f"image-{i}.{IMAGE_TYPES[m]}" for i, (m, _) in enumerate(images, 1)]
    if provider == "gemini" and images:
        prompt = IMAGE_NOTE.format(n=len(names), names=", ".join(names)) + prompt
    else:
        prompt = NO_TOOLS_NOTE.get(provider, "") + prompt
    as_arg = "-p={prompt}" in args
    if as_arg and Path(exe).suffix.lower() in (".bat", ".cmd"):
        # cmd.exe re-parses a batch file's arguments: quotes, %, & and | in the
        # prompt could run commands. Only real executables get the prompt as an arg.
        raise CliMissing(f"{binary} is a batch-file wrapper ({exe}); point PATH at its .exe")
    arg_prompt = _fit_arg(prompt) if as_arg else ""
    argv = [exe, *(a.replace("{prompt}", arg_prompt) for a in args)]
    if model:
        argv[1:1] = ["--model", model]
    stream = provider == "claude" and bool(images)
    if stream:
        argv += ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
    if provider == "gemini" and images:
        argv[1:1] = ["--settings", _AGY_IMAGE_SETTINGS]
    stdin_text = _claude_stream_input(prompt, images) if stream else (None if as_arg else prompt)
    # Empty cwd: the CLI sees nothing but the prompt (and, for agy, the pasted images).
    with tempfile.TemporaryDirectory(prefix="openstudy-ai-") as cwd:
        if provider == "gemini":
            for name, (_, data) in zip(names, images):
                (Path(cwd) / name).write_bytes(data)
        proc = subprocess.run(
            argv, input=stdin_text, stdin=subprocess.DEVNULL if stdin_text is None else None,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=cwd, env={**os.environ, "PATH": path}, timeout=TIMEOUT_S,
        )
    return _claude_stream_result(proc) if stream else proc
