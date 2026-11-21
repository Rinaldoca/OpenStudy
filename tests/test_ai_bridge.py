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

    def fake_run(provider, prompt, model="", images=None, workdir=None):
        seen.update(provider=provider, prompt=prompt)
        return subprocess.CompletedProcess([], 0, stdout="the answer", stderr="")
    monkeypatch.setattr(ai_cli, "run", fake_run)
    status, data = _call(bridge, "/run", {"provider": "claude", "prompt": "hi ✓"})
    assert status == 200 and data["stdout"] == "the answer" and seen == {"provider": "claude", "prompt": "hi ✓"}

    assert _call(bridge, "/run", {"provider": "rm -rf", "prompt": "x"})[0] == 400

    def missing(provider, prompt, model="", images=None, workdir=None):
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


def test_images_and_models_reach_each_cli_the_right_way(monkeypatch):
    import json as _json
    from pathlib import Path as _Path

    seen = {}

    def fake_subprocess_run(argv, **kw):
        seen.update(argv=argv, input=kw.get("input"), files=sorted(p.name for p in _Path(kw["cwd"]).iterdir()))
        if "stream-json" in argv:  # claude with images: answer comes back as stream-json
            out = '{"type":"system"}\n{"type":"result","result":"Green","is_error":false}\n'
            return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")
        return subprocess.CompletedProcess(argv, 0, stdout="ok", stderr="")
    monkeypatch.setattr(ai_cli.shutil, "which", lambda b, **k: f"/usr/bin/{b}")
    monkeypatch.setattr(ai_cli.subprocess, "run", fake_subprocess_run)
    png = ("image/png", b"\x89PNGfake")

    proc = ai_cli.run("claude", "what colour?", "sonnet", [png])
    assert proc.stdout == "Green" and proc.returncode == 0
    assert seen["argv"][1:3] == ["--model", "sonnet"] and "--tools" in seen["argv"]
    block = _json.loads(seen["input"])["message"]["content"]
    assert block[0]["type"] == "image" and block[0]["source"]["media_type"] == "image/png"
    assert block[1] == {"type": "text", "text": "what colour?"} and seen["files"] == []

    # agy can read any host file once a file tool is allowed, so it never gets
    # images (they'd have to be files) and always runs with every tool denied.
    with pytest.raises(ValueError, match="only Claude"):
        ai_cli.run("gemini", "what colour?", "", [png])
    ai_cli.run("gemini", "what is a DFA?", "gemini-3.8-flash-high")
    argv = seen["argv"]
    settings = _json.loads(argv[argv.index("--settings") + 1])["permissions"]
    assert "allow" not in settings and seen["files"] == []
    for tool in ("view_file", "list_dir", "grep_search", "run_command", "read_url_content", "write_to_file"):
        assert f"{tool}(*)" in settings["deny"]
    assert argv[argv.index("--model") + 1] == "gemini-3.8-flash-high" and "plan" in argv

    with pytest.raises(ValueError):
        ai_cli.run("claude", "x", "sonnet; rm -rf /")
    with pytest.raises(ValueError):
        ai_cli.run("claude", "x", "", [("image/svg+xml", b"<svg/>")])


def test_model_list_parses_agy_models(monkeypatch):
    monkeypatch.setattr(ai_cli, "_models_cache", {})
    monkeypatch.setattr(ai_cli.shutil, "which", lambda b, **k: f"/usr/bin/{b}")
    out = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\nnot a model line!\n"
    monkeypatch.setattr(ai_cli.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout=out, stderr=""))
    assert ai_cli.models("gemini") == [("", "Default"), ("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"),
                                        ("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)")]
    assert ai_cli.models("claude")[0] == ("", "Default")
