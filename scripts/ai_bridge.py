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
  POST /run        {"provider", "prompt"} → {"returncode", "stdout", "stderr"}

Listens on 127.0.0.1 only; Docker Desktop forwards host.docker.internal there.
Without a console (pythonw.exe, a logon task) it logs to ai_bridge.log next to
the --env-file, or to --log-file.
"""
from __future__ import annotations

import argparse
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

MAX_BODY = 2_000_000
_slots = threading.BoundedSemaphore(3)  # at most 3 CLI runs at once
SECRET = ""


def _secret_from_env_file(path: Path) -> str:
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() == "AI_BRIDGE_SECRET":
            return value.strip().strip('"').strip("'")
    return ""


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
            if provider not in ai_cli.COMMANDS or not isinstance(prompt, str) or not prompt:
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return self._reply(400, {"error": "expected {provider, prompt}"})
        if not _slots.acquire(timeout=30):
            return self._reply(503, {"error": "busy, try again"})
        try:
            proc = ai_cli.run(provider, prompt)
        except ai_cli.CliMissing as exc:
            return self._reply(400, {"error": "missing", "message": str(exc)})
        except subprocess.TimeoutExpired:
            return self._reply(504, {"error": "timeout"})
        finally:
            _slots.release()
        self._reply(200, {"returncode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr})


def main() -> int:
    global SECRET
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
        _secret_from_env_file(args.env_file) if args.env_file else "")
    if len(SECRET) < 24:
        print("AI_BRIDGE_SECRET missing or shorter than 24 characters", file=sys.stderr)
        return 2
    print(f"ai bridge on http://{args.host}:{args.port} — installed: {ai_cli.installed()}", file=sys.stderr)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
