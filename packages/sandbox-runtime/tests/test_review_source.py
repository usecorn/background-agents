from pathlib import Path

import pytest

from sandbox_runtime.review_source import ReviewSource, ReviewSourceError


def test_reads_only_manifest_paths_and_bounds_results(tmp_path: Path):
    (tmp_path / "a.py").write_text("first\nneedle\nneedle\n")
    (tmp_path / "secret").write_text("unlisted secret")
    with ReviewSource(tmp_path, ["a.py"]) as source:
        assert source.read("a.py") == "first\nneedle\nneedle\n"
        assert source.list_paths() == ["a.py"]
        assert source.search("needle", limit=1) == {
            "matches": [{"path": "a.py", "line": 2, "text": "needle"}],
            "truncated": True,
        }
        with pytest.raises(ReviewSourceError, match="PATH_NOT_IN_MANIFEST"):
            source.read("secret")


@pytest.mark.parametrize("path", ["../secret", "/etc/passwd", "a/../secret", "a//b", ".git/config"])
def test_rejects_unsafe_manifest_paths(tmp_path: Path, path: str):
    with pytest.raises(ReviewSourceError, match="INVALID_MANIFEST_PATH"):
        ReviewSource(tmp_path, [path])


def test_refuses_symlink_files_and_symlink_directories(tmp_path: Path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret").write_text("protected")
    root = tmp_path / "source"
    root.mkdir()
    (root / "file").symlink_to(outside / "secret")
    (root / "dir").symlink_to(outside, target_is_directory=True)
    with ReviewSource(root, ["file", "dir/secret"]) as source:
        for path in source.list_paths():
            with pytest.raises(ReviewSourceError, match="UNREADABLE_SOURCE"):
                source.read(path)


def test_refuses_binary_large_and_special_files(tmp_path: Path):
    import os

    (tmp_path / "binary").write_bytes(b"\x00\xff")
    (tmp_path / "large").write_bytes(b"a" * (256 * 1024 + 1))
    os.mkfifo(tmp_path / "pipe")
    with ReviewSource(tmp_path, ["binary", "large", "pipe"]) as source:
        for path, reason in [
            ("binary", "BINARY_SOURCE"),
            ("large", "SOURCE_TOO_LARGE"),
            ("pipe", "UNREADABLE_SOURCE"),
        ]:
            with pytest.raises(ReviewSourceError, match=reason):
                source.read(path)


def test_rechecks_paths_after_manifest_creation(tmp_path: Path):
    (tmp_path / "a").write_text("safe")
    with ReviewSource(tmp_path, ["a"]) as source:
        (tmp_path / "a").unlink()
        (tmp_path / "a").symlink_to("/etc/passwd")
        with pytest.raises(ReviewSourceError, match="UNREADABLE_SOURCE"):
            source.read("a")


def test_search_reports_unreadable_scope_instead_of_silently_skipping(tmp_path: Path):
    with (
        ReviewSource(tmp_path, ["missing"]) as source,
        pytest.raises(ReviewSourceError, match="UNREADABLE_SOURCE"),
    ):
        source.search("anything")


def test_refuses_hardlinks_and_closed_readers(tmp_path: Path):
    import os

    (tmp_path / "original").write_text("data")
    os.link(tmp_path / "original", tmp_path / "linked")
    source = ReviewSource(tmp_path, ["linked"])
    try:
        with pytest.raises(ReviewSourceError, match="UNREADABLE_SOURCE"):
            source.read("linked")
    finally:
        source.close()
    with pytest.raises(ReviewSourceError, match="SOURCE_CLOSED"):
        source.read("linked")
