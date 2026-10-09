"""Exercise trusted launch loading and production CLI selection."""

import hashlib
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime import entrypoint
from sandbox_runtime.review_launch import prepare_review_launch
from sandbox_runtime.review_source import ReviewSourceError
from sandbox_runtime.runtime_config import RuntimeConfig


def setup_launch(tmp_path):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    (checkout / "a").write_text("source")
    context = tmp_path / "launch.json"
    context.write_text(
        json.dumps(
            {
                "version": 1,
                "session_id": "session",
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "checkout": str(checkout),
                "destination": str(tmp_path / "attempt"),
                "state_root": str(tmp_path / "state"),
                "hashes": {"a": hashlib.sha256(b"source").hexdigest()},
            }
        )
    )
    context.chmod(0o600)
    config = RuntimeConfig.from_env({"SESSION_CONFIG": json.dumps({"session_id": "session"})})
    return context, config


def test_prepare_binds_session_and_stages_source(tmp_path):
    context, config = setup_launch(tmp_path)
    profile = prepare_review_launch(context, config)
    assert (profile.source_root / "a").read_text() == "source"
    assert profile.model == config.opencode_config().model


@pytest.mark.parametrize("change", ["session", "model", "permissions", "unknown", "version"])
def test_invalid_launch_does_not_stage(tmp_path, change):
    context, config = setup_launch(tmp_path)
    data = json.loads(context.read_text())
    if change == "session":
        data["session_id"] = "other"
    elif change == "model":
        data["model"] = "other"
    elif change == "unknown":
        data["shell"] = "echo unsafe"
    elif change == "version":
        data["version"] = True
    else:
        context.chmod(0o644)
    context.write_text(json.dumps(data))
    with pytest.raises(ReviewSourceError, match="INVALID_REVIEW_LAUNCH"):
        prepare_review_launch(context, config)
    assert not (tmp_path / "attempt").exists()


async def test_cli_selects_managed_profile_and_propagates_failure(tmp_path, monkeypatch):
    context, config = setup_launch(tmp_path)
    monkeypatch.setenv("SESSION_CONFIG", json.dumps({"session_id": config.session_id}))
    monkeypatch.setattr(entrypoint, "apply_image_environment", lambda: None)
    supervisor = MagicMock(run=AsyncMock(return_value=False))
    build = MagicMock(return_value=supervisor)
    monkeypatch.setattr(entrypoint, "build_supervisor", build)
    monkeypatch.setattr(entrypoint, "install_signal_handlers", lambda _: None)
    assert await entrypoint.main(["--managed-review-context", str(context)]) == 1
    assert build.call_args.kwargs["review_profile"].source_root.is_dir()
    supervisor.run.assert_awaited_once()


@pytest.mark.parametrize("case", ["symlink", "restore", "state_in_checkout"])
def test_untrusted_or_incompatible_context_never_stages(tmp_path, monkeypatch, case):
    context, config = setup_launch(tmp_path)
    if case == "symlink":
        alias = tmp_path / "alias.json"
        alias.symlink_to(context)
        context = alias
    elif case == "restore":
        monkeypatch.setenv("RESTORED_FROM_SNAPSHOT", "true")
    else:
        data = json.loads(context.read_text())
        data["state_root"] = str(tmp_path / "checkout" / "state")
        context.write_text(json.dumps(data))
    with pytest.raises(ReviewSourceError, match="INVALID_REVIEW_LAUNCH"):
        prepare_review_launch(context, config)
    assert not (tmp_path / "attempt").exists()


def test_restore_verifies_retained_source_and_preserves_state(tmp_path, monkeypatch):
    context, config = setup_launch(tmp_path)
    original = prepare_review_launch(context, config)
    for directory in ("home", "config", "data", "cache", "state", "work"):
        (original.state_root / directory).mkdir(parents=True)
    marker = original.state_root / "data" / "conversation-marker"
    marker.write_text("retained")
    monkeypatch.setenv("RESTORED_FROM_SNAPSHOT", "true")
    restored = prepare_review_launch(context, config)
    assert restored == original
    assert marker.read_text() == "retained"


@pytest.mark.parametrize("damage", ["source", "manifest", "missing_state"])
def test_restore_refuses_damaged_snapshot_without_recreating_it(tmp_path, monkeypatch, damage):
    context, config = setup_launch(tmp_path)
    original = prepare_review_launch(context, config)
    for directory in ("home", "config", "data", "cache", "state", "work"):
        (original.state_root / directory).mkdir(parents=True)
    if damage == "source":
        target = original.source_root / "a"
        target.chmod(0o600)
        target.write_text("changed")
        target.chmod(0o400)
    elif damage == "manifest":
        original.manifest_path.chmod(0o600)
        original.manifest_path.write_text("[]")
        original.manifest_path.chmod(0o400)
    else:
        (original.state_root / "data").rmdir()
    monkeypatch.setenv("RESTORED_FROM_SNAPSHOT", "true")
    with pytest.raises(ReviewSourceError):
        prepare_review_launch(context, config)
    if damage == "source":
        assert (original.source_root / "a").read_text() == "changed"
    if damage == "missing_state":
        assert not (original.state_root / "data").exists()
