"""Only a completed assistant response to the current prompt is a verdict candidate."""

import pytest

from sandbox_runtime.review_response import terminal_response


def message(**overrides):
    info = {
        "id": "assistant-1",
        "role": "assistant",
        "parentID": "prompt-1",
        "finish": "stop",
        "time": {"created": 100, "completed": 200},
    }
    info.update(overrides)
    return {"info": info, "parts": [{"type": "text", "text": '{"verdict":"CLEAN"}'}]}


def test_returns_exact_final_text_and_vendor_message_binding():
    result = terminal_response([message()], "prompt-1")
    assert result == {
        "assistantMessageId": "assistant-1",
        "parentMessageId": "prompt-1",
        "text": '{"verdict":"CLEAN"}',
    }


@pytest.mark.parametrize(
    "override",
    [
        {"role": "user"},
        {"parentID": "old-prompt"},
        {"summary": True},
        {"error": {"message": "failure"}},
        {"finish": "tool-calls"},
        {"time": {"created": 100}},
    ],
)
def test_invalid_or_unfinished_message_is_not_a_result(override):
    assert terminal_response([message(**override)], "prompt-1") is None


def test_only_newest_current_prompt_assistant_can_supply_result():
    old = message()
    unfinished = message(id="assistant-2", time={"created": 300})
    assert terminal_response([old, unfinished], "prompt-1") is None
    assert terminal_response([old, message(id="ambiguous")], "prompt-1") is None
