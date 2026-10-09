"""Read-only, manifest-scoped source access for the trusted review tool process.

The deployment must supply an immutable source mount and a controller-generated
manifest. This module does not execute code, expand globs, invoke a shell or read
paths outside that manifest. Model/provider credentials must stay in a different
process identity; these path checks are not a replacement for that isolation.
"""

from __future__ import annotations

import os
import stat
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

MAX_FILE_BYTES = 256 * 1024
MAX_SEARCH_BYTES = 8 * 1024 * 1024


class ReviewSourceError(Exception):
    """Static reason codes safe to return without host paths or OS error text."""


class ReviewSource:
    def __init__(self, root: Path, paths: list[str]) -> None:
        if len(paths) > 10_000 or len(set(paths)) != len(paths):
            raise ReviewSourceError("INVALID_MANIFEST")
        for path in paths:
            if (
                not isinstance(path, str)
                or len(path) > 4096
                or "\x00" in path
                or any(part in ("", ".", "..", ".git") for part in path.split("/"))
            ):
                raise ReviewSourceError("INVALID_MANIFEST_PATH")
        self._paths = sorted(paths)
        self._allowed = frozenset(paths)
        try:
            self._root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError:
            raise ReviewSourceError("UNREADABLE_SOURCE_ROOT") from None

    def __enter__(self) -> ReviewSource:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def close(self) -> None:
        if self._root_fd >= 0:
            os.close(self._root_fd)
            self._root_fd = -1

    def list_paths(self, offset: int = 0, limit: int = 100) -> list[str]:
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise ReviewSourceError("INVALID_PAGE")
        return self._paths[offset : offset + limit]

    def read(self, path: str) -> str:
        if path not in self._allowed:
            raise ReviewSourceError("PATH_NOT_IN_MANIFEST")
        if self._root_fd < 0:
            raise ReviewSourceError("SOURCE_CLOSED")
        directory_fd = os.dup(self._root_fd)
        file_fd = -1
        try:
            parts = path.split("/")
            for part in parts[:-1]:
                child_fd = os.open(
                    part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd
                )
                os.close(directory_fd)
                directory_fd = child_fd
            file_fd = os.open(
                parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd
            )
            info = os.fstat(file_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ReviewSourceError("UNREADABLE_SOURCE")
            if info.st_size > MAX_FILE_BYTES:
                raise ReviewSourceError("SOURCE_TOO_LARGE")
            with os.fdopen(file_fd, "rb") as stream:
                file_fd = -1
                data = stream.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                raise ReviewSourceError("SOURCE_TOO_LARGE")
            if b"\x00" in data:
                raise ReviewSourceError("BINARY_SOURCE")
            try:
                return data.decode("utf-8")
            except UnicodeDecodeError:
                raise ReviewSourceError("BINARY_SOURCE") from None
        except OSError:
            raise ReviewSourceError("UNREADABLE_SOURCE") from None
        finally:
            if file_fd >= 0:
                os.close(file_fd)
            os.close(directory_fd)

    def search(self, query: str, limit: int = 100) -> dict[str, Any]:
        if not isinstance(query, str) or not 1 <= len(query) <= 512:
            raise ReviewSourceError("INVALID_QUERY")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ReviewSourceError("INVALID_LIMIT")
        matches: list[dict[str, Any]] = []
        scanned = 0
        truncated = False
        for path in self._paths:
            text = self.read(path)
            scanned += len(text.encode("utf-8"))
            if scanned > MAX_SEARCH_BYTES:
                raise ReviewSourceError("SEARCH_SCOPE_TOO_LARGE")
            for line_number, line in enumerate(text.splitlines(), 1):
                if query in line:
                    if len(matches) == limit:
                        return {"matches": matches, "truncated": True}
                    truncated |= len(line) > 2048
                    matches.append({"path": path, "line": line_number, "text": line[:2048]})
        return {"matches": matches, "truncated": truncated}
