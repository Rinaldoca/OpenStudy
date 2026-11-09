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


def test_quiz_parses_json_wrapped_in_prose_and_scores_grades(monkeypatch):
    import asyncio
    import pytest
    from fastapi import HTTPException
    from app.routers import quiz

    assert quiz._parse_json('Sure! ```json\n{"a": {"b": 1}}\n``` hope it helps') == {"a": {"b": 1}}
    with pytest.raises(HTTPException):
        quiz._parse_json("no quiz today")

    async def fake_ai(provider, prompt, user):
        assert "Student: (no answer)" in prompt  # missing answers are padded
        return '{"results": [{"id": 1, "correct": true, "feedback": "ok"}, {"id": 2, "correct": false, "feedback": "no"}],' \
               ' "summary": "fine", "gaps": ["pumping lemma"], "next_steps": ["redo ex. 3"]}'
    monkeypatch.setattr(quiz, "run_ai", fake_ai)
    qs = [quiz.QuizQuestion(id=i, type="short", question="q", answer="a") for i in (1, 2)]
    out = asyncio.run(quiz.grade(quiz.GradeBody(provider="claude", questions=qs, answers=["a"]), user=None))
    assert (out["score"], out["total"], out["gaps"]) == (1, 2, ["pumping lemma"])
