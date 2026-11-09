"""Flattening viewer notes into a PDF (no DB needed)."""
import base64

import fitz

from app.routers.notes import flatten

# 1x1 red PNG
PNG = "data:image/png;base64," + base64.b64encode(
    bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de"
                  "0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082")
).decode()


def test_flatten_orders_pages_inserts_blank_and_draws_notes():
    src = fitz.open()
    for i in (1, 2):
        src.new_page(width=300, height=400).insert_text((20, 40), f"original {i}")
    data = {
        "layout": ["p2", "b:x", "p1"],
        "pages": {
            "p2": {"strokes": [{"c": "#ff0000", "w": 3, "pts": [10, 10, 100, 100, 150, 50]}]},
            "b:x": {"items": [{"t": "text", "text": "my note", "x": 20, "y": 20, "size": 12},
                              {"t": "img", "src": PNG, "x": 50, "y": 80, "w": 40, "h": 40}]},
            "p1": {"strokes": [{"c": "#ffff00", "w": 12, "hl": True, "pts": [5, 5]}]},  # single dot
        },
    }
    out = fitz.open(stream=flatten(src.tobytes(), data), filetype="pdf")
    assert out.page_count == 3
    assert "original 2" in out[0].get_text() and "original 1" in out[2].get_text()
    assert out[1].get_text().strip() == "my note" and out[1].rect.width == 300
    assert out[0].get_drawings() and out[2].get_drawings()
    assert out[1].get_images()


def test_flatten_without_notes_keeps_pages():
    src = fitz.open()
    src.new_page()
    assert fitz.open(stream=flatten(src.tobytes(), {}), filetype="pdf").page_count == 1


def test_text_box_wraps_at_its_width():
    src = fitz.open()
    src.new_page(width=300, height=400)
    long = "pumping lemma " * 8
    data = {"pages": {"p1": {"items": [{"t": "text", "text": long, "x": 20, "y": 20, "w": 120, "h": 20, "size": 12}]}}}
    page = fitz.open(stream=flatten(src.tobytes(), data), filetype="pdf")[0]
    words = page.get_text("words")
    assert len(words) == 16  # nothing cut off
    assert max(w[2] for w in words) <= 20 + 120 + 1  # wrapped inside the box
    assert len({round(w[1]) for w in words}) > 1  # on several lines
