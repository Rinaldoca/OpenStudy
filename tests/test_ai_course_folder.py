"""Letting the AI read the course folder: claude only, read-only tools, run
inside that folder; the bridge never resolves a folder outside its study root."""
import asyncio
import importlib.util
import subprocess
from pathlib import Path
from uuid import UUID

import pytest
from fastapi import HTTPException

from app import ai_cli

_spec = importlib.util.spec_from_file_location(
    "ai_bridge_cf", Path(__file__).resolve().parent.parent / "scripts" / "ai_bridge.py")
ai_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ai_bridge)

OPERATOR = UUID("00000000-0000-0000-0000-000000000001")


def test_claude_reads_the_course_folder_with_read_only_tools(tmp_path, monkeypatch):
    seen = {}

    def fake(argv, **kw):
        seen.update(argv=argv, cwd=kw["cwd"], input=kw.get("input"))
        return subprocess.CompletedProcess(argv, 0, stdout="ok", stderr="")
    monkeypatch.setattr(ai_cli.shutil, "which", lambda b, **k: f"/usr/bin/{b}")
    monkeypatch.setattr(ai_cli.subprocess, "run", fake)

    ai_cli.run("claude", "Question: what's on sheet 3?", workdir=tmp_path)
    assert seen["cwd"] == str(tmp_path)
    assert seen["argv"][seen["argv"].index("--tools") + 1] == "Read,Glob,Grep"
    assert seen["input"].startswith(ai_cli.COURSE_NOTE)

    ai_cli.run("claude", "Question: hi")  # no folder: empty temp dir, no tools at all
    assert seen["cwd"] != str(tmp_path) and seen["argv"][seen["argv"].index("--tools") + 1] == ""

    with pytest.raises(ValueError, match="only Claude"):
        ai_cli.run("gemini", "x", workdir=tmp_path)
    with pytest.raises(ValueError):
        ai_cli.run("claude", "x", workdir=tmp_path / "missing")


def test_bridge_resolves_course_folders_only_inside_its_study_root(tmp_path, monkeypatch):
    root = tmp_path / "courses"
    (root / str(OPERATOR) / "THIN" / "Woche 01").mkdir(parents=True)
    (tmp_path / "private").mkdir()
    monkeypatch.setattr(ai_bridge, "STUDY_ROOT", root)

    assert ai_bridge.course_dir(f"{OPERATOR}/THIN") == (root / str(OPERATOR) / "THIN").resolve()
    for bad in ("", "..", f"{OPERATOR}/../../private", "../private", "C:/Windows", f"{OPERATOR}/nope",
                "/etc", f"{OPERATOR}\\..\\..\\private"):
        with pytest.raises(ValueError):
            ai_bridge.course_dir(bad)
    monkeypatch.setattr(ai_bridge, "STUDY_ROOT", None)
    with pytest.raises(ValueError, match="AI_BRIDGE_STUDY_ROOT"):
        ai_bridge.course_dir(f"{OPERATOR}/THIN")


def test_run_ai_sends_the_folder_relative_to_the_file_store(tmp_path, monkeypatch):
    from app.auth import User
    from app.routers import ai

    monkeypatch.setenv("STUDY_ROOT", str(tmp_path))
    monkeypatch.setenv("LOCAL_MODE", "false")
    monkeypatch.setenv("AI_BRIDGE_URL", "http://bridge.test:8765")
    (tmp_path / str(OPERATOR) / "THIN").mkdir(parents=True)
    (tmp_path / str(OPERATOR) / "notes.pdf").write_bytes(b"%PDF")
    user = User(id=OPERATOR, email="op@test", display_name="Lucas")
    sent = {}

    async def fake_bridge(url, provider, prompt, model, images, folder):
        sent.update(provider=provider, folder=folder)
        return 0, "answer", "", None
    monkeypatch.setattr(ai, "_run_bridge", fake_bridge)

    assert asyncio.run(ai.run_ai("claude", "q", user, course="THIN")) == "answer"
    assert sent == {"provider": "claude", "folder": f"{OPERATOR}/THIN"}
    # Gemini can't read folders: it just answers from the prompt.
    asyncio.run(ai.run_ai("gemini", "q", user, course="THIN"))
    assert sent == {"provider": "gemini", "folder": ""}
    for bad in ("../x", "THIN/../..", "notes.pdf", "NOPE"):
        with pytest.raises(HTTPException):
            asyncio.run(ai.run_ai("claude", "q", user, course=bad))
