"""Token usage from the CLIs' JSON output (shapes copied from real runs, 2026-11-21)."""
import json
import subprocess

from app import ai_cli

CLAUDE_JSON = {
    "type": "result", "subtype": "success", "is_error": False, "result": "ok",
    "usage": {"input_tokens": 2, "cache_creation_input_tokens": 2688, "cache_read_input_tokens": 649,
              "output_tokens": 4, "output_tokens_details": {"thinking_tokens": 0}},
    "modelUsage": {"claude-haiku-5-5": {"inputTokens": 2, "outputTokens": 4}},
    "total_cost_usd": 0.00054629,
}
AGY_JSON = {"conversation_id": "x", "status": "SUCCESS", "response": "ok\n", "num_turns": 1,
            "usage": {"input_tokens": 9445, "output_tokens": 1143, "thinking_tokens": 1142,
                      "cache_read_tokens": 0, "total_tokens": 10588}}


def _proc(stdout: str, code: int = 0) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(["x"], code, stdout=stdout, stderr="")


def test_claude_json_answer_and_usage():
    res = ai_cli._parse_json_output("claude", _proc(json.dumps(CLAUDE_JSON)))
    assert res.stdout == "ok" and res.returncode == 0
    assert ai_cli.usage_of(res) == {"input": 3339, "output": 4, "cache_read": 649, "thinking": 0,
                                    "model": "claude-haiku-5-5"}
    err = dict(CLAUDE_JSON, is_error=True, result="Failed to authenticate")
    res = ai_cli._parse_json_output("claude", _proc(json.dumps(err), 1))
    assert res.returncode != 0 and res.stdout == "" and "authenticate" in res.stderr


def test_claude_stream_json_result_line_is_used():
    out = '{"type":"system","subtype":"init"}\n' + json.dumps(CLAUDE_JSON) + "\n"
    res = ai_cli._parse_json_output("claude", _proc(out))
    assert res.stdout == "ok" and ai_cli.usage_of(res)["output"] == 4


def test_agy_json_answer_usage_and_errors():
    res = ai_cli._parse_json_output("gemini", _proc(json.dumps(AGY_JSON)))
    assert res.stdout == "ok\n" and ai_cli.usage_of(res) == {
        "input": 9445, "output": 1143, "cache_read": 0, "thinking": 1142, "model": ""}
    bad = {"status": "ERROR", "response": "", "error": "authentication required", "usage": {}}
    res = ai_cli._parse_json_output("gemini", _proc(json.dumps(bad), 1))
    assert res.returncode != 0 and "authentication required" in res.stderr


def test_non_json_output_passes_through():
    res = ai_cli._parse_json_output("claude", _proc("plain text answer"))
    assert res.stdout == "plain text answer" and ai_cli.usage_of(res) is None
