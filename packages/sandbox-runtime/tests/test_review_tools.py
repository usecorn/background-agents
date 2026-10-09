import json
import os
import subprocess
import sys
from pathlib import Path


def run_tools(
    tmp_path: Path, requests: list[dict], *, raw: str | None = None, exit_code: int = 0
) -> list[dict]:
    source = tmp_path / "source"
    source.mkdir()
    (source / "fixture.py").write_text("needle\n")
    (source / "unlisted").write_text("private-fixture")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(["fixture.py"]))
    result = subprocess.run(
        [sys.executable, "-m", "sandbox_runtime.review_tools", str(source), str(manifest)],
        input=raw
        if raw is not None
        else "".join(json.dumps(request) + "\n" for request in requests),
        text=True,
        capture_output=True,
        timeout=5,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")},
    )
    assert result.returncode == exit_code, result.stderr
    return [json.loads(line) for line in result.stdout.splitlines()]


def test_real_stdio_handshake_and_bounded_tool_calls(tmp_path: Path):
    responses = run_tools(
        tmp_path,
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2024-11-05"},
            },
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "read_source", "arguments": {"path": "fixture.py"}},
            },
        ],
    )
    assert len(responses) == 3
    assert responses[0]["result"]["protocolVersion"] == "2024-11-05"
    assert {tool["name"] for tool in responses[1]["result"]["tools"]} == {
        "list_source",
        "read_source",
        "search_source",
    }
    assert json.loads(responses[2]["result"]["content"][0]["text"]) == {
        "path": "fixture.py",
        "text": "needle\n",
    }


def test_rejects_unknown_tools_options_and_unlisted_files(tmp_path: Path):
    responses = run_tools(
        tmp_path,
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "shell", "arguments": {"command": "id"}},
            },
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "read_source", "arguments": {"path": "fixture.py", "root": "/"}},
            },
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "read_source", "arguments": {"path": "unlisted"}},
            },
        ],
    )
    assert responses[0]["error"]["code"] == -32602
    assert responses[1]["error"]["code"] == -32602
    assert responses[2]["result"]["isError"] is True
    assert "PATH_NOT_IN_MANIFEST" in responses[2]["result"]["content"][0]["text"]
    assert "private-fixture" not in json.dumps(responses)


def test_malformed_json_does_not_desynchronize_following_request(tmp_path: Path):
    responses = run_tools(
        tmp_path, [], raw='invalid json\n{"jsonrpc":"2.0","id":9,"method":"ping"}\n'
    )
    assert responses[0]["error"]["code"] == -32700
    assert responses[1] == {"jsonrpc": "2.0", "id": 9, "result": {}}


def test_oversized_request_closes_stream_without_processing_tail(tmp_path: Path):
    responses = run_tools(
        tmp_path,
        [],
        raw="x" * (64 * 1024 + 1) + '\n{"jsonrpc":"2.0","id":9,"method":"ping"}\n',
        exit_code=1,
    )
    assert len(responses) == 1
    assert responses[0]["error"]["message"] == "Oversized request"
