"""Saved, shared Ask AI chats (app/routers/ai_chats.py) against a real
Postgres; the AI call itself is faked."""
import base64
import uuid

import pytest


def _png() -> bytes:
    import struct
    import zlib

    raw = b"\x00" + b"\x10\x80\x20" * 2
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


@pytest.mark.asyncio
async def test_shared_chat_round_trip(db_conn, monkeypatch):
    from httpx import ASGITransport, AsyncClient

    import app.db as db_module
    from app.auth import User, require_user, _sentinel_user
    from app.main import create_app
    from app.routers import ai_chats

    monkeypatch.setattr(db_module, "_pool", db_conn)
    monkeypatch.setenv("LOCAL_MODE", "false")
    monkeypatch.setenv("AI_BRIDGE_URL", "http://bridge.test:8765")
    monkeypatch.setenv("AI_USERS", "all")

    friend = User(id=uuid.uuid4(), email=f"friend-{uuid.uuid4().hex[:6]}@example.com", display_name="Kiril")
    await db_module.execute("INSERT INTO users (id, email, display_name) VALUES (%s, %s, %s)",
                            str(friend.id), friend.email, friend.display_name)

    calls = []

    async def fake_run_ai(provider, prompt, user, model="", images=None, course=None):
        calls.append({"provider": provider, "prompt": prompt, "model": model, "images": images or [],
                      "course": course})
        return "**Bold** answer with $x^2$", {"input": 1200, "output": 80, "cache_read": 900,
                                               "thinking": 0, "model": "claude-sonnet-5-5"}
    monkeypatch.setattr(ai_chats, "run_ai_full", fake_run_ai)

    app = create_app()
    current = {"user": _sentinel_user()}
    app.dependency_overrides[require_user] = lambda: current["user"]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        chat = (await ac.post("/api/ai/chats", json={})).json()
        png = _png()
        r = await ac.post(f"/api/ai/chats/{chat['id']}/messages", json={
            "provider": "claude", "model": "sonnet", "question": "What is shown here?\nsecond line",
            "selection": "a DFA", "images": [{"mime": "image/png", "data": base64.b64encode(png).decode()}],
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["title"] == "What is shown here?"  # first line of the first question
        assert [m["role"] for m in body["messages"]] == ["user", "assistant"]
        assert body["messages"][1]["content"] == "**Bold** answer with $x^2$" and not body["pending"]
        assert body["messages"][1]["usage"]["output"] == 80 and body["messages"][0]["usage"] is None
        assert calls[0]["model"] == "sonnet" and calls[0]["images"] == [("image/png", png)]
        assert "LaTeX" in calls[0]["prompt"] and "<selected_text>\na DFA" in calls[0]["prompt"]

        img_id = body["messages"][0]["images"][0]
        img = await ac.get(f"/api/ai/images/{img_id}")
        assert img.status_code == 200 and img.content == png and img.headers["content-type"] == "image/png"

        # The friend sees the same chat and continues it; the earlier turn and the
        # selection carry over, and the prompt says who asked what.
        current["user"] = friend
        listed = (await ac.get("/api/ai/chats")).json()
        assert [c["id"] for c in listed] == [chat["id"]]
        r = await ac.post(f"/api/ai/chats/{chat['id']}/messages", json={"provider": "gemini", "question": "And why?"})
        assert r.status_code == 200, r.text
        p = calls[1]["prompt"]
        assert '<previous_question by="' in p and "[+1 image(s), not resent]" in p
        assert "<previous_answer>**Bold** answer" in p and "Question from Kiril: And why?" in p
        assert "<selected_text>\na DFA" in p
        msgs = r.json()["messages"]
        assert [m["author_name"] for m in msgs if m["role"] == "user"][-1] == "Kiril"

        # A failed AI call is stored as an error message, not lost.
        async def failing(*a, **k):
            from fastapi import HTTPException
            raise HTTPException(502, "claude failed: rate limited")
        monkeypatch.setattr(ai_chats, "run_ai_full", failing)
        msgs = (await ac.post(f"/api/ai/chats/{chat['id']}/messages", json={"provider": "claude", "question": "x"})).json()["messages"]
        assert msgs[-1]["role"] == "error" and "rate limited" in msgs[-1]["content"]

        # Bad images are refused before anything is stored.
        bad = await ac.post(f"/api/ai/chats/{chat['id']}/messages", json={
            "provider": "claude", "question": "y", "images": [{"mime": "image/svg+xml", "data": "PHN2Zz4="}]})
        assert bad.status_code == 400

        assert (await ac.patch(f"/api/ai/chats/{chat['id']}", json={"title": "DFAs"})).status_code == 200
        assert (await ac.get(f"/api/ai/chats/{chat['id']}")).json()["title"] == "DFAs"

        # Without AI_USERS=all the friend has no access at all.
        monkeypatch.setenv("AI_USERS", "operator")
        assert (await ac.get("/api/ai/chats")).status_code == 403
        assert (await ac.get(f"/api/ai/images/{img_id}")).status_code == 403

        current["user"] = _sentinel_user()
        assert (await ac.delete(f"/api/ai/chats/{chat['id']}")).status_code == 200
        assert (await ac.get(f"/api/ai/chats/{chat['id']}")).status_code == 404
