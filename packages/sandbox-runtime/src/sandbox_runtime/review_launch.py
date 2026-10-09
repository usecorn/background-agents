"""Load provider-written review launch data, never repository configuration.

The provider must place the context and destination in a private trusted parent.
The context contains no credentials. Restores verify retained source before
reusing trusted state; they never recreate missing state or repair source.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import TYPE_CHECKING

from .harness.base import HarnessId
from .review_profile import ReviewProfile
from .review_source import ReviewSourceError
from .review_staging import stage_source, verify_staged_source
from .runtime_config import BootMode

if TYPE_CHECKING:
    from .runtime_config import RuntimeConfig

_FIELDS = {
    "version",
    "session_id",
    "provider",
    "model",
    "checkout",
    "destination",
    "state_root",
    "hashes",
}
_MAX_CONTEXT_BYTES = 2 * 1024 * 1024


def prepare_review_launch(context: Path, config: RuntimeConfig) -> ReviewProfile:
    try:
        fd = os.open(context, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_uid != os.geteuid()
                or info.st_mode & 0o077
            ):
                raise ValueError
            raw = stream.read(_MAX_CONTEXT_BYTES + 1)
        if len(raw) > _MAX_CONTEXT_BYTES:
            raise ValueError
        data = json.loads(raw)
        model = config.opencode_config()
        if (
            not isinstance(data, dict)
            or set(data) != _FIELDS
            or type(data["version"]) is not int
            or data["version"] != 1
            or not config.session_id
            or data["session_id"] != config.session_id
            or data["provider"] != model.provider
            or data["model"] != model.model
            or model.provider not in {"anthropic", "openai"}
            or config.harness is not HarnessId.OPENCODE
            or BootMode.from_env(os.environ) not in {BootMode.FRESH, BootMode.SNAPSHOT_RESTORE}
            or not isinstance(data["hashes"], dict)
        ):
            raise ValueError
        paths = [Path(data[key]) for key in ("checkout", "destination", "state_root")]
        if any(not path.is_absolute() for path in paths):
            raise ValueError
        checkout, destination, state = paths
        resolved_source = checkout.resolve()
        if (
            context.resolve().is_relative_to(resolved_source)
            or state.resolve().is_relative_to(resolved_source)
            or resolved_source.is_relative_to(state.resolve())
            or destination.resolve().is_relative_to(state.resolve())
            or state.resolve().is_relative_to(destination.resolve())
        ):
            raise ValueError
    except (OSError, ValueError, TypeError, KeyError):
        raise ReviewSourceError("INVALID_REVIEW_LAUNCH") from None
    if BootMode.from_env(os.environ) is BootMode.SNAPSHOT_RESTORE:
        if any(
            path.is_symlink() or not path.is_dir()
            for path in [
                state,
                *(state / name for name in ("home", "config", "data", "cache", "state", "work")),
            ]
        ):
            raise ReviewSourceError("INVALID_REVIEW_LAUNCH")
        staged = verify_staged_source(data["hashes"], destination)
    else:
        staged = stage_source(checkout, data["hashes"], destination)
    return ReviewProfile(
        staged.source_root, staged.manifest_path, state, model.provider, model.model
    )
