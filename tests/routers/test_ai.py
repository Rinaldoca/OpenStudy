"""Prompt building for /api/ai/ask (the CLI call itself isn't exercised)."""
import fitz

from app.routers.ai import AskBody, Turn, _pdf_text, _prompt


def test_pdf_text_reads_only_pages_around_the_current_one():
    doc = fitz.open()
    for i in range(1, 6):
        doc.new_page().insert_text((72, 72), f"content of page {i}")
    data = doc.tobytes()

    text = _pdf_text(data, page=3)
    assert "[page 2]" in text and "[page 4]" in text
    assert "page 1" not in text and "page 5" not in text
    assert _pdf_text(data, page=5).count("[page") == 2  # clamps at the end
    assert _pdf_text(data, page=None).count("[page") == 5


def test_prompt_includes_material_selection_and_history():
    body = AskBody(
        provider="claude", question="why?", selection="the pumping lemma",
        path="THIN/l1.pdf", page=4, history=[Turn(question="what?", answer="a lemma")],
    )
    p = _prompt(body, "MATERIAL")
    assert 'file="THIN/l1.pdf" (around page 4)' in p
    assert "MATERIAL" in p and "the pumping lemma" in p
    assert p.index("a lemma") < p.index("Question: why?")
