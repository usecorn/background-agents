"""Real Linux namespace checks, not assertions about sandbox command flags."""

import json
import os
import shutil
import subprocess
import sys

import pytest

from sandbox_runtime import review_isolation
from sandbox_runtime.review_isolation import isolated_command, tools_command

requires_namespaces = pytest.mark.skipif(
    sys.platform != "linux" or not shutil.which("bwrap") or not shutil.which("setpriv"),
    reason="Real isolation proof requires Linux, Bubblewrap and setpriv",
)


@requires_namespaces
def test_boundary_denies_host_secrets_writes_network_and_parent_processes(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "sample.py").write_text("original")
    secret = tmp_path / "provider-key"
    secret.write_text("synthetic-secret")
    manifest = tmp_path / "manifest.json"
    manifest.write_text('["sample.py"]')
    probe = f"""
import os, socket
from pathlib import Path
assert "REVIEW_TEST_SECRET" not in os.environ
assert not Path({str(secret)!r}).exists()
assert not Path("/proc/{os.getpid()}/environ").exists()
assert Path("/source/sample.py").read_text() == "original"
try:
    Path("/source/sample.py").write_text("changed")
except OSError:
    pass
else:
    raise AssertionError("source is writable")
s = socket.socket()
s.settimeout(1)
assert s.connect_ex(("1.1.1.1", 443)) != 0
assert not Path("/proc").exists()
print("boundary-pass")
"""
    result = subprocess.run(
        isolated_command(source, manifest, ["-c", probe]),
        env={**os.environ, "REVIEW_TEST_SECRET": "synthetic"},
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "boundary-pass"
    assert (source / "sample.py").read_text() == "original"


@requires_namespaces
def test_mcp_works_inside_boundary(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "sample.py").write_text("print('review me')")
    manifest = tmp_path / "manifest.json"
    manifest.write_text('["sample.py"]')
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "read_source", "arguments": {"path": "sample.py"}},
    }
    result = subprocess.run(
        tools_command(source, manifest),
        input=json.dumps(request) + "\n",
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    response = json.loads(result.stdout)
    assert not response["result"]["isError"]
    assert "review me" in response["result"]["content"][0]["text"]


def test_missing_isolation_binary_never_runs_tools(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            review_isolation.__file__,
            str(tmp_path),
            str(tmp_path / "manifest.json"),
        ],
        env={**os.environ, "PATH": "/nonexistent"},
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode != 0
    assert not result.stdout
    assert result.stderr.strip() == "Review isolation unavailable"
