"""Select a bounded completed assistant response from a trusted OpenCode snapshot."""

from __future__ import annotations

from typing import Any


def terminal_response(messages: list[Any], prompt_id: str) -> dict[str, str] | None:
    candidates = []
    for message in messages:
        if not isinstance(message, dict) or not isinstance(message.get("info"), dict):
            return None
        info = message["info"]
        if info.get("role") != "assistant" or info.get("parentID") != prompt_id:
            continue
        if info.get("summary") is True:
            continue
        created = info.get("time", {}).get("created")
        if type(created) not in (int, float):
            return None
        candidates.append((created, message))
    if not candidates:
        return None
    newest = max(created for created, _ in candidates)
    matching = [message for created, message in candidates if created == newest]
    if len(matching) != 1:
        return None
    message = matching[0]
    info = message["info"]
    completed = info.get("time", {}).get("completed")
    if (
        info.get("finish") != "stop"
        or info.get("error") is not None
        or type(completed) not in (int, float)
        or completed < newest
        or not isinstance(info.get("id"), str)
        or not info["id"]
    ):
        return None
    parts = message.get("parts")
    if not isinstance(parts, list):
        return None
    chunks = []
    for part in parts:
        if not isinstance(part, dict):
            return None
        if part.get("type") == "text":
            if not isinstance(part.get("text"), str):
                return None
            chunks.append(part["text"])
    text = "".join(chunks)
    if not text or len(text.encode("utf-8")) > 1024 * 1024:
        return None
    return {"assistantMessageId": info["id"], "parentMessageId": prompt_id, "text": text}
