"""Minimal stdio MCP surface for manifest-scoped review tools.

Root and manifest are trusted process arguments, never tool-call arguments.
No credential, shell, HTTP, plugin or dependency-installing tool is exposed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from .review_source import ReviewSource, ReviewSourceError

MAX_REQUEST_BYTES = 64 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
TOOLS = [
    {
        "name": "list_source",
        "description": "List a page of controller-approved source paths.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "offset": {"type": "integer", "minimum": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "read_source",
        "description": "Read one approved UTF-8 source file. Errors mean unreadable review scope.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search_source",
        "description": "Search approved source for a literal string, with bounded results.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 512},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
]


def error(identifier: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": identifier, "error": {"code": code, "message": message}}


def dispatch(source: ReviewSource, request: Any) -> dict[str, Any] | None:
    if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
        return error(None, -32600, "Invalid request")
    identifier = request.get("id")
    if "id" not in request:
        return None
    if not isinstance(identifier, (str, int)) or isinstance(identifier, bool):
        return error(None, -32600, "Invalid request")
    method = request.get("method")
    params = request.get("params", {})
    if not isinstance(params, dict):
        return error(identifier, -32602, "Invalid params")
    if method == "initialize":
        version = params.get("protocolVersion")
        result: dict[str, Any] = {
            "protocolVersion": version
            if version in ("2024-11-05", "2025-03-26", "2025-06-18")
            else "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "corn-review-source", "version": "1.0.0"},
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments", {})
        if not isinstance(arguments, dict):
            return error(identifier, -32602, "Invalid params")
        try:
            if name == "list_source" and arguments.keys() <= {"offset", "limit"}:
                value: Any = {"paths": source.list_paths(**arguments)}
            elif (
                name == "read_source"
                and arguments.keys() == {"path"}
                and isinstance(arguments["path"], str)
            ):
                value = {"path": arguments["path"], "text": source.read(arguments["path"])}
            elif (
                name == "search_source"
                and "query" in arguments
                and arguments.keys() <= {"query", "limit"}
            ):
                value = source.search(**arguments)
            else:
                return error(identifier, -32602, "Unknown tool or invalid arguments")
            result = {"content": [{"type": "text", "text": json.dumps(value)}], "isError": False}
        except ReviewSourceError as exc:
            result = {
                "content": [{"type": "text", "text": json.dumps({"error": str(exc)})}],
                "isError": True,
            }
    else:
        return error(identifier, -32601, "Method not found")
    return {"jsonrpc": "2.0", "id": identifier, "result": result}


def main() -> int:
    try:
        if len(sys.argv) != 3:
            raise ValueError("Invalid arguments")
        with Path(sys.argv[2]).open("rb") as manifest:
            content = manifest.read(MAX_MANIFEST_BYTES + 1)
        if len(content) > MAX_MANIFEST_BYTES:
            raise ValueError("Oversized manifest")
        paths = json.loads(content)
        if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
            raise ValueError("Invalid manifest")
        with ReviewSource(Path(sys.argv[1]), paths) as source:
            while line := sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1):
                if len(line) > MAX_REQUEST_BYTES:
                    sys.stdout.write(json.dumps(error(None, -32600, "Oversized request")) + "\n")
                    sys.stdout.flush()
                    return 1
                try:
                    response = dispatch(source, json.loads(line))
                except (ValueError, UnicodeDecodeError):
                    response = error(None, -32700, "Parse error")
                if response is not None:
                    sys.stdout.write(json.dumps(response) + "\n")
                    sys.stdout.flush()
        return 0
    except Exception:
        # No tracebacks or host paths on the model-visible protocol channel.
        sys.stderr.write("REVIEW_TOOLS_FAILED\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
