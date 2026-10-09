"""Trusted review launch inputs must not merge ordinary sandbox configuration."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.opencode_server import OpenCodeServer
from sandbox_runtime.review_profile import ReviewProfile
from sandbox_runtime.runtime_config import OpenCodeConfig


def profile(tmp_path):
    source = tmp_path / "hostile"
    source.mkdir()
    manifest = tmp_path / "manifest.json"
    manifest.write_text('["sample.py"]')
    return ReviewProfile(source, manifest, tmp_path / "trusted", "anthropic", "claude-sonnet-4-6")


def test_review_environment_does_not_inherit_global_or_repository_configuration(
    tmp_path, monkeypatch
):
    review = profile(tmp_path)
    monkeypatch.setenv("OPENCODE_CONFIG", str(review.source_root / "opencode.json"))
    monkeypatch.setenv("NODE_OPTIONS", "--import=/tmp/hostile.js")
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", "controller-secret")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "provider-secret")
    env = review.environment()
    assert env["ANTHROPIC_API_KEY"] == "provider-secret"
    assert not {"OPENCODE_CONFIG", "NODE_OPTIONS", "SANDBOX_AUTH_TOKEN"} & env.keys()
    assert env["HOME"] == str(review.state_root / "home")
    config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
    assert config["permission"] == {"*": "deny", "review_source_*": "allow"}
    assert config["default_agent"] == "reviewer"
    assert set(config["mcp"]) == {"review_source"}
    assert config["instructions"] == []
    assert env["OPENCODE_DISABLE_PROJECT_CONFIG"] == "1"


async def test_review_start_bypasses_normal_setup_and_binds_loopback(tmp_path, monkeypatch):
    review = profile(tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic")
    server = OpenCodeServer(
        OpenCodeConfig(
            review.provider, review.model, ({"name": "hostile"},), True, review.source_root
        ),
        asyncio.Event(),
        MagicMock(),
        MagicMock(),
    )
    with (
        patch.object(server, "_setup_managed_oauth") as oauth,
        patch.object(server, "_prepare_opencode_filesystem") as filesystem,
        patch.object(server, "_install_mcp_packages", new_callable=AsyncMock) as install,
        patch.object(server, "_wait_for_health", new_callable=AsyncMock),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_subprocess_exec", new_callable=AsyncMock
        ) as spawn,
    ):
        await server.start((), review.source_root, review_profile=review)
    oauth.assert_not_called()
    filesystem.assert_not_called()
    install.assert_not_awaited()
    assert spawn.call_args.kwargs["cwd"] == review.state_root / "work"
    assert "127.0.0.1" in spawn.call_args.args
    assert "0.0.0.0" not in spawn.call_args.args
    assert "--print-logs" not in spawn.call_args.args


def test_state_cannot_be_inside_untrusted_source(tmp_path):
    review = profile(tmp_path)
    with pytest.raises(ValueError, match="separate"):
        ReviewProfile(
            review.source_root,
            review.manifest_path,
            review.source_root / "state",
            review.provider,
            review.model,
        ).environment()
