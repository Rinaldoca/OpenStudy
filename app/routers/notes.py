"""Notes drawn on top of PDFs (pen, highlighter, images, text, blank pages).

  GET /api/notes?path=…         → {data} (null if none yet)
  PUT /api/notes  {path, data}  → save (the viewer autosaves)
  GET /api/notes/export?path=…  → the PDF with the notes flattened in

Notes are per user and never written into the original file. `data`:
  {"layout": ["p1", "p2", "b:k3j", "p3"],          # page order; "b:*" = blank page
   "pages": {"p1": {"strokes": [{"c": "#e11d48", "w": 2, "hl": false, "pts": [x, y, x, y, …]}],
                    "items":   [{"t": "img", "src": "data:image/png;base64,…", "x", "y", "w", "h"},
                                {"t": "text", "text": "…", "x", "y", "w", "h", "size": 14, "c": "#111"}]}}}
in PDF points, origin top-left (pdf.js viewport at scale 1 = PyMuPDF page coords).
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import Response

from .. import db
from ..auth import require_user, User
from ..intents import files as files_intent

router = APIRouter(prefix="/notes", tags=["notes"], dependencies=[Depends(require_user)])

_MAX_BYTES = 25 * 1024 * 1024  # pasted images are downscaled client-side; this is a backstop


def _key(path: str) -> str:
    p = (path or "").strip().strip("/")
    if not p or ".." in p or not p.lower().endswith(".pdf"):
        raise HTTPException(400, "expected a .pdf path")
    return p


@router.get("")
async def get_notes(path: str = Query(...), user: User = Depends(require_user)) -> dict:
    row = await db.fetchrow("SELECT data FROM pdf_notes WHERE user_id = %s AND path = %s", user.id, _key(path))
    return {"data": row["data"] if row else None}


@router.put("")
async def put_notes(body: dict[str, Any] = Body(...), user: User = Depends(require_user)) -> dict:
    data = body.get("data")
    if not isinstance(data, dict):
        raise HTTPException(400, "data must be an object")
    raw = json.dumps(data)
    if len(raw) > _MAX_BYTES:
        raise HTTPException(413, "notes too large — remove some images")
    await db.execute(
        "INSERT INTO pdf_notes (user_id, path, data, updated_at) VALUES (%s, %s, %s::jsonb, now()) "
        "ON CONFLICT (user_id, path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
        user.id, _key(body.get("path") or ""), raw,
    )
    return {"ok": True}


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
    row = await db.fetchrow("SELECT data FROM pdf_notes WHERE user_id = %s AND path = %s", user.id, key)
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
