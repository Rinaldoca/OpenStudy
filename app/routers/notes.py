"""Notes drawn on top of PDFs (pen, highlighter, images, text, blank pages).

  GET  /api/notes?path=…&since=N     → {version, data} ({version} only if unchanged since N)
  POST /api/notes/ops {path, base, ops} → apply per-stroke changes → {version, data?}
  GET  /api/notes/export?path=…       → the PDF with the notes flattened in

Notes are shared per *file*: everyone who can open the same file on disk
(a course folder shared with a friend) edits one set of notes, keyed by the
file's resolved real path. Private files resolve to private keys. Changes
travel as ops on single strokes/items (by `id`), applied under a row lock,
so two people drawing at once never overwrite each other; viewers poll
`version` to pick up the other's changes. Notes are never written into the
original file. `data`:
  {"layout": ["p1", "p2", "b:k3j", "p3"],          # page order; "b:*" = blank page
   "pages": {"p1": {"strokes": [{"id": "k3j9x0", "c": "#e11d48", "w": 2, "hl": false, "pts": [x, y, x, y, …]}],
                    "items":   [{"t": "img", "src": "data:image/png;base64,…", "x", "y", "w", "h"},
                                {"t": "text", "text": "…", "x", "y", "w", "h", "size": 14, "c": "#111"}]}}}
in PDF points, origin top-left (pdf.js viewport at scale 1 = PyMuPDF page coords).
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
import uuid
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import Response

from .. import db
from ..auth import require_user, User
from ..intents import files as files_intent
from ..services import storage as storage_svc

router = APIRouter(prefix="/notes", tags=["notes"], dependencies=[Depends(require_user)])

_MAX_BYTES = 25 * 1024 * 1024  # pasted images are downscaled client-side; this is a backstop


def _key(path: str) -> str:
    p = (path or "").strip().strip("/")
    if not p or ".." in p or not p.lower().endswith(".pdf"):
        raise HTTPException(400, "expected a .pdf path")
    return p


def _doc_key(user: User, path: str) -> str:
    """The file's real path: identical for everyone sharing the folder it's in."""
    try:
        target = storage_svc._safe_resolve(user.id, path)
    except ValueError as exc:
        raise HTTPException(400, "invalid path") from exc
    if not target.is_file():
        raise HTTPException(404, f"not found: {path}")
    return str(target)


def _new_id() -> str:
    return uuid.uuid4().hex[:10]


def ensure_ids(data: dict) -> dict:
    """Give every stroke/item an id (notes saved before sharing have none)."""
    for page in (data.get("pages") or {}).values():
        for kind in ("strokes", "items"):
            for el in page.get(kind) or []:
                el.setdefault("id", _new_id())
    return data


def apply_ops(data: dict, ops: list[dict]) -> dict:
    """Apply viewer ops in order. Unknown/malformed ops are skipped, never fatal.

      {"op": "put", "slot": "p1", "kind": "strokes"|"items", "el": {..., "id"}}  add or replace
      {"op": "del", "slot": "p1", "kind": …, "id": "…"}                          remove
      {"op": "layout", "layout": ["p1", "b:x", …]}                               page order
    """
    pages = data.setdefault("pages", {})
    for op in ops:
        kind = op.get("kind")
        if op.get("op") == "layout" and isinstance(op.get("layout"), list):
            data["layout"] = [str(s)[:40] for s in op["layout"]][:2000]
        elif op.get("op") in ("put", "del") and kind in ("strokes", "items") and isinstance(op.get("slot"), str):
            page = pages.setdefault(op["slot"][:40], {})
            arr = page.setdefault(kind, [])
            el = op.get("el") if op["op"] == "put" else None
            oid = (el or {}).get("id") if el is not None else op.get("id")
            if not isinstance(oid, str) or (op["op"] == "put" and not isinstance(el, dict)):
                continue
            at = next((i for i, e in enumerate(arr) if e.get("id") == oid), None)
            if op["op"] == "del":
                if at is not None:
                    arr.pop(at)
            elif at is None:
                arr.append(el)
            else:
                arr[at] = el
    return data


async def _load(key: str, user: User, path: str) -> dict:
    """The file's shared notes; on first open, seeded from this user's pre-sharing notes."""
    row = await db.fetchrow("SELECT data, version FROM pdf_shared_notes WHERE doc_key = %s", key)
    if row:
        return row
    legacy = await db.fetchrow("SELECT data FROM pdf_notes WHERE user_id = %s AND path = %s", user.id, path)
    data = ensure_ids(legacy["data"] if legacy else {"pages": {}})
    await db.execute(
        "INSERT INTO pdf_shared_notes (doc_key, data, updated_by) VALUES (%s, %s::jsonb, %s) ON CONFLICT DO NOTHING",
        key, json.dumps(data), user.id,
    )
    return await db.fetchrow("SELECT data, version FROM pdf_shared_notes WHERE doc_key = %s", key)


@router.get("")
async def get_notes(path: str = Query(...), since: int | None = Query(default=None), user: User = Depends(require_user)) -> dict:
    p = _key(path)
    row = await _load(_doc_key(user, p), user, p)
    if since is not None and since == row["version"]:
        return {"version": row["version"]}  # unchanged: skip resending (images can be big)
    return {"version": row["version"], "data": row["data"]}


@router.post("/ops")
async def post_ops(body: dict[str, Any] = Body(...), user: User = Depends(require_user)) -> dict:
    ops = body.get("ops")
    if not isinstance(ops, list) or len(ops) > 5000 or not all(isinstance(o, dict) for o in ops):
        raise HTTPException(400, "ops must be a list of objects")
    if len(json.dumps(ops)) > _MAX_BYTES:
        raise HTTPException(413, "change too large — use smaller images")
    p = _key(body.get("path") or "")
    key = _doc_key(user, p)
    await _load(key, user, p)  # make sure the row exists
    async with db.db() as conn, conn.transaction(), conn.cursor() as cur:
        await cur.execute("SELECT data, version FROM pdf_shared_notes WHERE doc_key = %s FOR UPDATE", (key,))
        row = await cur.fetchone()
        data = apply_ops(row["data"], ops)
        version = row["version"] + 1
        await cur.execute(
            "UPDATE pdf_shared_notes SET data = %s::jsonb, version = %s, updated_by = %s, updated_at = now() WHERE doc_key = %s",
            (json.dumps(data), version, user.id, key),
        )
    # Only resend the whole document if someone else changed it since the client's copy.
    if body.get("base") == row["version"]:
        return {"version": version}
    return {"version": version, "data": data}


def _rgb(hex_color: str) -> tuple[float, float, float]:
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", hex_color or "")
    v = int(m.group(1), 16) if m else 0
    return ((v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255)


def flatten(pdf: bytes, data: dict) -> bytes:
    """Render notes into a new PDF: original pages in `layout` order (blank
    pages sized like page 1), strokes as vector lines, images, text."""
    import fitz  # pymupdf

    src = fitz.open(stream=pdf, filetype="pdf")
    out = fitz.open()
    first = src[0].rect
    layout = data.get("layout") or [f"p{i + 1}" for i in range(src.page_count)]
    pages = data.get("pages") or {}
    for slot in layout:
        if slot.startswith("p") and slot[1:].isdigit() and 0 < int(slot[1:]) <= src.page_count:
            n = int(slot[1:]) - 1
            out.insert_pdf(src, from_page=n, to_page=n)
            page = out[-1]
        else:
            page = out.new_page(width=first.width, height=first.height)
        notes = pages.get(slot) or {}
        for s in notes.get("strokes") or []:
            pts = s.get("pts") or []
            points = [fitz.Point(pts[i], pts[i + 1]) for i in range(0, len(pts) - 1, 2)]
            if len(points) < 2:
                points = points * 2  # a dot
            shape = page.new_shape()
            shape.draw_polyline(points)
            shape.finish(color=_rgb(s.get("c")), width=float(s.get("w") or 2), closePath=False,
                         stroke_opacity=0.35 if s.get("hl") else 1, lineCap=1, lineJoin=1)
            shape.commit()
        for it in notes.get("items") or []:
            x, y = float(it.get("x", 0)), float(it.get("y", 0))
            if it.get("t") == "img" and str(it.get("src", "")).startswith("data:image/"):
                rect = fitz.Rect(x, y, x + float(it.get("w", 100)), y + float(it.get("h", 100)))
                page.insert_image(rect, stream=base64.b64decode(it["src"].split(",", 1)[1]))
            elif it.get("t") == "text" and it.get("text"):
                size = float(it.get("size") or 14)
                if it.get("w"):
                    # Text box: wrap at its width; let it run to the page bottom so nothing is cut.
                    rect = fitz.Rect(x, y, x + float(it["w"]), max(page.rect.height, y + size * 2))
                    page.insert_textbox(rect, str(it["text"]), fontsize=size, fontname="helv",
                                        color=_rgb(it.get("c")), lineheight=1.25)
                else:  # notes saved before text boxes existed
                    for i, line in enumerate(str(it["text"]).splitlines()):
                        page.insert_text(fitz.Point(x, y + size * (i + 1)), line, fontsize=size, color=_rgb(it.get("c")))
    return out.tobytes(garbage=3, deflate=True)


@router.get("/export")
async def export(path: str = Query(...), user: User = Depends(require_user)) -> Response:
    key = _key(path)
    row = await _load(_doc_key(user, key), user, key)
    try:
        pdf = await files_intent.download(user.id, key)
    except Exception as exc:
        raise HTTPException(404, f"not found: {key}") from exc
    result = await asyncio.to_thread(flatten, pdf, row["data"] if row else {})
    name = key.rsplit("/", 1)[-1][:-4] + " (notes).pdf"
    return Response(
        result,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"},
    )
