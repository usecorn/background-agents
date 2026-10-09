"""Review boot must never pass through ordinary repository or interactive services."""

from dataclasses import replace
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.review_profile import ReviewProfile
from sandbox_runtime.runtime_config import BootMode
from tests.runtime_helpers import make_supervisor


def managed_supervisor(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    manifest = tmp_path / "manifest.json"
    manifest.write_text("[]")
    supervisor = make_supervisor(
        {
            "CONTROL_PLANE_URL": "https://example.test",
            "SANDBOX_AUTH_TOKEN": "synthetic",
            "SESSION_CONFIG": '{"session_id":"review", "model":"claude-sonnet-4-6"}',
        },
        workspace_path=tmp_path,
        review_profile=ReviewProfile(
            source, manifest, tmp_path / "trusted", "anthropic", "claude-sonnet-4-6"
        ),
    )
    supervisor.boot_events = MagicMock()
    supervisor._report_fatal_error = AsyncMock()
    supervisor.harness_process.start = AsyncMock()
    supervisor.harness_process.stop = AsyncMock()
    supervisor.harness_process.exit_code = MagicMock(return_value=None)
    supervisor.agent_bridge.start = AsyncMock()
    supervisor.agent_bridge.stop = AsyncMock()
    supervisor.agent_bridge.exit_code = MagicMock(return_value=0)
    supervisor.agent_bridge.started = MagicMock(return_value=True)
    supervisor.repository_boot.boot = AsyncMock(
        side_effect=AssertionError("repository hooks reached")
    )
    supervisor.repository_boot.prepare_tunnel_environment = MagicMock(
        side_effect=AssertionError("tunnels reached")
    )
    for service in (supervisor.code_server, supervisor.web_terminal, supervisor.browser_desktop):
        service.start = AsyncMock(side_effect=AssertionError("interactive service reached"))
        service.stop = AsyncMock()
    supervisor.managed_skills = MagicMock(
        materialize=AsyncMock(side_effect=AssertionError("skills reached"))
    )
    supervisor.memory = MagicMock(
        materialize=AsyncMock(side_effect=AssertionError("memory reached"))
    )
    return supervisor


async def test_review_boot_skips_hooks_and_interactive_services(tmp_path):
    supervisor = managed_supervisor(tmp_path)
    assert await supervisor.run()
    supervisor.harness_process.start.assert_awaited_once_with(
        (), supervisor.review_profile.state_root / "work", review_profile=supervisor.review_profile
    )
    supervisor.agent_bridge.start.assert_awaited_once_with(early_connect=False)
    supervisor.repository_boot.boot.assert_not_awaited()
    supervisor.managed_skills.materialize.assert_not_awaited()
    supervisor.memory.materialize.assert_not_awaited()
    supervisor.harness_process.stop.assert_awaited_once()
    supervisor._report_fatal_error.assert_not_awaited()


@pytest.mark.parametrize("service", ["harness_process", "agent_bridge"])
async def test_review_crash_is_fatal_without_automatic_replay(tmp_path, service):
    supervisor = managed_supervisor(tmp_path)
    getattr(supervisor, service).exit_code.return_value = 23
    assert not await supervisor.run()
    supervisor.harness_process.start.assert_awaited_once()
    supervisor.agent_bridge.start.assert_awaited_once()
    supervisor._report_fatal_error.assert_awaited_once_with("Managed review process exited")


@pytest.mark.parametrize("mode", [BootMode.BUILD, BootMode.REPO_IMAGE])
async def test_review_rejects_image_build_or_repository_image(tmp_path, monkeypatch, mode):
    supervisor = managed_supervisor(tmp_path)
    monkeypatch.setenv("IMAGE_BUILD_MODE" if mode is BootMode.BUILD else "FROM_REPO_IMAGE", "true")
    assert not await supervisor.run()
    supervisor.harness_process.start.assert_not_awaited()
    supervisor.agent_bridge.start.assert_not_awaited()


async def test_review_rejects_docker_enabled_config(tmp_path):
    supervisor = managed_supervisor(tmp_path)
    supervisor.config = replace(supervisor.config, docker_enabled=True)
    assert not await supervisor.run()
    supervisor.harness_process.start.assert_not_awaited()


async def test_review_cannot_run_without_bridge_identity(tmp_path):
    supervisor = managed_supervisor(tmp_path)
    supervisor.config = replace(supervisor.config, sandbox_token="")
    assert not await supervisor.run()
    supervisor.harness_process.start.assert_not_awaited()
