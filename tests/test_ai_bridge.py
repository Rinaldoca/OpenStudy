"""scripts/ai_bridge.py + app/ai_cli.py (the CLIs themselves are faked)."""
import importlib.util
import json
import subprocess
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from app import ai_cli

_spec = importlib.util.spec_from_file_location(
    "ai_bridge", Path(__file__).resolve().parent.parent / "scripts" / "ai_bridge.py")
ai_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ai_bridge)

SECRET = "s" * 32


@pytest.fixture
def bridge(monkeypatch):
    monkeypatch.setattr(ai_bridge, "SECRET", SECRET)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), ai_bridge.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def _call(url, path, body=None, secret=SECRET):
    req = urllib.request.Request(url + path, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_bridge_requires_the_secret(bridge):
    assert _call(bridge, "/providers", secret="wrong")[0] == 401
    status, data = _call(bridge, "/providers")
    assert status == 200 and set(data["installed"]) == set(ai_cli.COMMANDS)


def test_bridge_runs_the_cli_and_reports_errors(bridge, monkeypatch):
    seen = {}

    def fake_run(provider, prompt):
        seen.update(provider=provider, prompt=prompt)
        return subprocess.CompletedProcess([], 0, stdout="the answer", stderr="")
    monkeypatch.setattr(ai_cli, "run", fake_run)
    status, data = _call(bridge, "/run", {"provider": "claude", "prompt": "hi ✓"})
    assert status == 200 and data["stdout"] == "the answer" and seen == {"provider": "claude", "prompt": "hi ✓"}

    assert _call(bridge, "/run", {"provider": "rm -rf", "prompt": "x"})[0] == 400

    def missing(provider, prompt):
        raise ai_cli.CliMissing("agy isn't installed")
    monkeypatch.setattr(ai_cli, "run", missing)
    status, data = _call(bridge, "/run", {"provider": "gemini", "prompt": "x"})
    assert status == 400 and data == {"error": "missing", "message": "agy isn't installed"}


def test_long_prompts_passed_as_an_argument_keep_the_question(monkeypatch):
    monkeypatch.setattr(ai_cli, "_MAX_ARG_PROMPT", 1000)
    fitted = ai_cli._fit_arg("intro\n\n" + "x" * 5000 + "\n\nQuestion: what is a DFA?")
    assert len(fitted) <= 1000 and fitted.endswith("Question: what is a DFA?") and "truncated" in fitted
    assert ai_cli._fit_arg("short") == "short"


def test_batch_file_wrappers_never_get_the_prompt_as_an_argument(monkeypatch):
    monkeypatch.setattr(ai_cli.shutil, "which", lambda *a, **k: r"C:\tools\agy.cmd")
    with pytest.raises(ai_cli.CliMissing):
        ai_cli.run("gemini", "a & del *")


def test_bridge_logs_to_a_file_when_there_is_no_console(tmp_path, monkeypatch):
    # pythonw.exe (a Windows logon task) has sys.stderr = None; logging a request used to crash it.
    env = tmp_path / ".env"
    env.write_text("AI_BRIDGE_SECRET=" + SECRET + "\n", encoding="utf-8")
    monkeypatch.setattr(ai_bridge.sys, "stderr", None)
    monkeypatch.setattr(ai_bridge.sys, "argv", ["ai_bridge.py", "--env-file", str(env), "--port", "0"])
    started = {}

    class FakeServer:
        def __init__(self, addr, handler):
            started["addr"] = addr

        def serve_forever(self):
            ai_bridge.sys.stderr.write("request line\n")

    monkeypatch.setattr(ai_bridge, "ThreadingHTTPServer", FakeServer)
    assert ai_bridge.main() == 0
    ai_bridge.sys.stderr.close()
    log = (tmp_path / "ai_bridge.log").read_text(encoding="utf-8")
    assert "ai bridge on" in log and "request line" in log


def test_agy_is_told_to_answer_without_tools(monkeypatch):
    seen = {}

    def fake_subprocess_run(argv, **kw):
        seen["argv"] = argv
        return subprocess.CompletedProcess(argv, 0, stdout="ok", stderr="")
    monkeypatch.setattr(ai_cli.shutil, "which", lambda *a, **k: "/usr/bin/agy")
    monkeypatch.setattr(ai_cli.subprocess, "run", fake_subprocess_run)
    ai_cli.run("gemini", "Question: what is a DFA?")
    prompt_arg = next(a for a in seen["argv"] if a.startswith("-p="))
    assert prompt_arg.startswith("-p=Answer directly from the text below. Do not use any tools")
    assert prompt_arg.endswith("Question: what is a DFA?")
    assert "--mode" in seen["argv"] and "plan" in seen["argv"]  # read-only plan mode stays on
