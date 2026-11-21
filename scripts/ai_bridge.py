#!/usr/bin/env python3
"""Ask-AI bridge: lets a Docker-hosted OpenStudy use the host owner's AI CLIs.

The backend container can't run `claude` / `agy` with your logins (Antigravity
keeps its Google sign-in in the OS keyring, which a container doesn't have).
This runs on the host instead, as you, and the backend calls it:

    backend (container) --HTTP + shared secret--> ai_bridge.py (host) --> claude / agy

Standard library only — run it with the host's normal Python, no venv:

    python scripts/ai_bridge.py --env-file .env          # reads AI_BRIDGE_SECRET from it

and in the backend's .env:

    AI_BRIDGE_URL=http://host.docker.internal:8765
    AI_BRIDGE_SECRET=<same random string>
    AI_USERS=operator        # or "all" to let every account use your subscriptions

Endpoints (all need `Authorization: Bearer <AI_BRIDGE_SECRET>`):
  GET  /providers  → {"installed": {"claude": true, ...}}
  GET  /models     → {"models": {"claude": [[id, label], ...], ...}}
  POST /run        {"provider", "prompt", "model"?, "images"?: [{"mime", "data" (base64)}],
                    "folder"?: course folder relative to the file store}
                   → {"returncode", "stdout", "stderr"}

"folder" lets the AI read that course folder (claude only, read-only tools).
It's resolved under AI_BRIDGE_STUDY_ROOT from the --env-file — this host's
path of the backend's STUDY_ROOT bind mount — and refused if it would land
anywhere else.

Listens on 127.0.0.1 only; Docker Desktop forwards host.docker.internal there.
Without a console (pythonw.exe, a logon task) it logs to ai_bridge.log next to
the --env-file, or to --log-file.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hmac
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import ai_cli  # noqa: E402  (stdlib-only module)

MAX_BODY = 45_000_000  # 6 images × 5 MB, base64-encoded, plus the prompt
_slots = threading.BoundedSemaphore(3)  # at most 3 CLI runs at once
SECRET = ""
STUDY_ROOT: Path | None = None


def _from_env_file(path: Path, name: str) -> str:
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() == name:
            return value.strip().strip('"').strip("'")
    return ""


def course_dir(folder: str) -> Path:
    """`folder` (e.g. "<user id>/THIN") under STUDY_ROOT, symlinks resolved;
    ValueError if it's missing, not a folder, or outside STUDY_ROOT."""
    if STUDY_ROOT is None:
        raise ValueError("this bridge has no AI_BRIDGE_STUDY_ROOT, so it can't open course folders")
    parts = [seg for seg in folder.replace("\\", "/").split("/") if seg]
    if not parts or any(seg in (".", "..") or ":" in seg for seg in parts):
        raise ValueError("invalid course folder")
    root = STUDY_ROOT.resolve()
    target = root.joinpath(*parts).resolve()
    if root not in target.parents or not target.is_dir():
        raise ValueError("course folder not found")
    return target


class Handler(BaseHTTPRequestHandler):
    server_version = "openstudy-ai-bridge"

    def log_message(self, fmt, *args):  # one short line per request, no prompt text
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def _reply(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authed(self) -> bool:
        got = self.headers.get("Authorization", "")
        if SECRET and hmac.compare_digest(got.encode(), f"Bearer {SECRET}".encode()):
            return True
        self._reply(401, {"error": "unauthorized"})
        return False

    def do_GET(self):
        if not self._authed():
            return
        if self.path == "/providers":
            return self._reply(200, {"installed": ai_cli.installed()})
        if self.path == "/models":
            installed = ai_cli.installed()
            return self._reply(200, {"models": {
                pid: ai_cli.models(pid) for pid in ai_cli.COMMANDS if installed.get(pid)}})
        self._reply(404, {"error": "not found"})

    def do_POST(self):
        if not self._authed():
            return
        if self.path != "/run":
            return self._reply(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            return self._reply(413, {"error": "body too large or empty"})
        try:
            body = json.loads(self.rfile.read(length))
            provider, prompt = body["provider"], body["prompt"]
            model = body.get("model") or ""
            folder = body.get("folder") or ""
            images = [(img["mime"], base64.b64decode(img["data"], validate=True))
                      for img in body.get("images") or []]
            if (provider not in ai_cli.COMMANDS or not isinstance(prompt, str) or not prompt
                    or not isinstance(model, str) or not isinstance(folder, str)):
                raise ValueError
        except (ValueError, KeyError, TypeError, binascii.Error):
            return self._reply(400, {"error": "expected {provider, prompt, model?, images?, folder?}"})
        if not _slots.acquire(timeout=30):
            return self._reply(503, {"error": "busy, try again"})
        try:
            proc = ai_cli.run(provider, prompt, model, images, course_dir(folder) if folder else None)
        except ai_cli.CliMissing as exc:
            return self._reply(400, {"error": "missing", "message": str(exc)})
        except ValueError as exc:
            return self._reply(400, {"error": "invalid", "message": str(exc)})
        except subprocess.TimeoutExpired:
            return self._reply(504, {"error": "timeout"})
        finally:
            _slots.release()
        self._reply(200, {"returncode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr,
                          "usage": ai_cli.usage_of(proc)})


def main() -> int:
    global SECRET, STUDY_ROOT
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--env-file", type=Path, help="read AI_BRIDGE_SECRET from this .env")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--log-file", type=Path, help="default: stderr, or ai_bridge.log beside --env-file without a console")
    args = ap.parse_args()
    log_file = args.log_file or (
        (args.env_file.resolve().parent / "ai_bridge.log") if sys.stderr is None and args.env_file else None)
    if log_file:
        sys.stderr = open(log_file, "a", encoding="utf-8", buffering=1)  # line-buffered
    elif sys.stderr is None:  # pythonw with nowhere to log: drop log lines rather than crash
        sys.stderr = open(os.devnull, "w")
    SECRET = os.environ.get("AI_BRIDGE_SECRET", "") or (
        _from_env_file(args.env_file, "AI_BRIDGE_SECRET") if args.env_file else "")
    root = os.environ.get("AI_BRIDGE_STUDY_ROOT", "") or (
        _from_env_file(args.env_file, "AI_BRIDGE_STUDY_ROOT") if args.env_file else "")
    STUDY_ROOT = Path(root) if root else None
    if len(SECRET) < 24:
        print("AI_BRIDGE_SECRET missing or shorter than 24 characters", file=sys.stderr)
        return 2
    print(f"ai bridge on http://{args.host}:{args.port} — installed: {ai_cli.installed()}"
          f" — course folders: {STUDY_ROOT or 'off'}", file=sys.stderr)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
