"""Copy controller-approved bytes into a private, read-only review attempt.

The destination parent must be trusted and inaccessible to repository processes.
Permissions prevent accidental writes; the tool namespace supplies the read-only
mount. They do not protect against the trusted host owner or root.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from sandbox_runtime.review_source import MAX_SEARCH_BYTES, ReviewSource, ReviewSourceError

if TYPE_CHECKING:
    from collections.abc import Mapping


@dataclass(frozen=True)
class StagedSource:
    source_root: Path
    manifest_path: Path


def stage_source(checkout: Path, hashes: Mapping[str, str], destination: Path) -> StagedSource:
    """Return only a complete copy whose bytes match every supplied SHA-256."""
    checkout = checkout.absolute()
    destination = destination.absolute()
    if destination.resolve().is_relative_to(checkout.resolve()):
        raise ReviewSourceError("INVALID_STAGING_DESTINATION")
    expected = dict(hashes)
    if any(
        not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
        for value in expected.values()
    ):
        raise ReviewSourceError("INVALID_SOURCE_DIGEST")
    try:
        destination.mkdir(mode=0o700)
    except FileExistsError:
        raise ReviewSourceError("STAGING_DESTINATION_EXISTS") from None
    except OSError:
        raise ReviewSourceError("STAGING_FAILED") from None
    try:
        pending = destination / ".pending"
        pending.mkdir(mode=0o700)
        total = 0
        with ReviewSource(checkout, list(expected)) as source:
            for path in sorted(expected):
                data = source.read(path).encode("utf-8")
                total += len(data)
                if total > MAX_SEARCH_BYTES:
                    raise ReviewSourceError("SOURCE_SCOPE_TOO_LARGE")
                if hashlib.sha256(data).hexdigest() != expected[path]:
                    raise ReviewSourceError("SOURCE_DIGEST_MISMATCH")
                target = pending / path
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with target.open("xb") as stream:
                    stream.write(data)
                target.chmod(0o400)
        manifest = destination / "manifest.json"
        manifest.write_text(json.dumps(sorted(expected)), encoding="utf-8")
        manifest.chmod(0o400)
        for directory, _, _ in os.walk(pending, topdown=False):
            Path(directory).chmod(0o500)
        root = destination / "source"
        pending.rename(root)
        destination.chmod(0o500)
        return StagedSource(root, manifest)
    except Exception as error:
        for directory, _, _ in os.walk(destination):
            Path(directory).chmod(0o700)
        shutil.rmtree(destination)
        if isinstance(error, ReviewSourceError):
            raise
        raise ReviewSourceError("STAGING_FAILED") from None
