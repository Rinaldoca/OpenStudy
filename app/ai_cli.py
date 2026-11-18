"""Run the AI CLIs (Claude Code, Antigravity, Codex) on a prompt.

Standard library only: it is imported by app/routers/ai.py (when the backend
itself runs on the user's computer, LOCAL_MODE) and by scripts/ai_bridge.py
(a tiny service on the host that the Docker backend calls, so the CLIs run
with the host owner's logins — see INSTALL.md → "Ask AI on a home server").

The CLIs run with tools off (or read-only) in an empty temp dir: they only
see the prompt we build.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
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


def run(provider: str, prompt: str) -> subprocess.CompletedProcess:
    """Run `prompt` through the provider's CLI. Raises CliMissing, KeyError
    (unknown provider) or subprocess.TimeoutExpired."""
    binary, args = COMMANDS[provider]
    path = search_path()
    exe = shutil.which(binary, path=path)
    if not exe:
        raise CliMissing(f"{binary} isn't installed — {LOGIN_HINT[provider]}")
    as_arg = "-p={prompt}" in args
    if as_arg and Path(exe).suffix.lower() in (".bat", ".cmd"):
        # cmd.exe re-parses a batch file's arguments: quotes, %, & and | in the
        # prompt could run commands. Only real executables get the prompt as an arg.
        raise CliMissing(f"{binary} is a batch-file wrapper ({exe}); point PATH at its .exe")
    arg_prompt = _fit_arg(prompt) if as_arg else ""
    argv = [exe, *(a.replace("{prompt}", arg_prompt) for a in args)]
    # Empty cwd: the CLI sees nothing but the prompt.
    with tempfile.TemporaryDirectory(prefix="openstudy-ai-") as cwd:
        return subprocess.run(
            argv, input=None if as_arg else prompt, stdin=subprocess.DEVNULL if as_arg else None,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=cwd, env={**os.environ, "PATH": path}, timeout=TIMEOUT_S,
        )
