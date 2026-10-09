"""Bound staging to controller content digests and publish only complete source."""

import hashlib
import json
import stat

import pytest

from sandbox_runtime.review_source import ReviewSource, ReviewSourceError
from sandbox_runtime.review_staging import stage_source


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def test_copy_is_independent_readonly_and_manifest_scoped(tmp_path):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    (checkout / "sample.py").write_text("original")
    (checkout / "unlisted").write_text("do not copy")
    staged = stage_source(checkout, {"sample.py": digest("original")}, tmp_path / "attempt")
    (checkout / "sample.py").write_text("changed later")
    assert (staged.source_root / "sample.py").read_text() == "original"
    assert not (staged.source_root / "unlisted").exists()
    assert json.loads(staged.manifest_path.read_text()) == ["sample.py"]
    assert not stat.S_IMODE(staged.source_root.stat().st_mode) & 0o222
    assert not stat.S_IMODE((staged.source_root / "sample.py").stat().st_mode) & 0o222


@pytest.mark.parametrize("case", ["mismatch", "symlink", "missing", "binary", "traversal"])
def test_invalid_or_changed_source_never_publishes_attempt(tmp_path, case):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    path = checkout / "sample.py"
    path.write_text("original")
    paths = {"sample.py": digest("original")}
    if case == "mismatch":
        path.write_text("changed")
    elif case == "symlink":
        path.unlink()
        path.symlink_to(tmp_path / "secret")
    elif case == "missing":
        path.unlink()
    elif case == "binary":
        path.write_bytes(b"\x00")
    else:
        paths = {"../secret": digest("original")}
    with pytest.raises(ReviewSourceError):
        stage_source(checkout, paths, tmp_path / "attempt")
    assert not (tmp_path / "attempt").exists()


def test_existing_attempt_is_never_overwritten(tmp_path):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    (attempt / "keep").write_text("existing")
    with pytest.raises(ReviewSourceError, match="STAGING_DESTINATION_EXISTS"):
        stage_source(checkout, {}, attempt)
    assert (attempt / "keep").read_text() == "existing"


def test_destination_inside_checkout_is_rejected(tmp_path):
    with pytest.raises(ReviewSourceError, match="INVALID_STAGING_DESTINATION"):
        stage_source(tmp_path, {}, tmp_path / "attempt")


def test_nested_bytes_and_reader_roundtrip(tmp_path):
    checkout = tmp_path / "checkout"
    (checkout / "nested").mkdir(parents=True)
    content = "hello\r\n日本語\n"
    (checkout / "nested" / "sample.py").write_bytes(content.encode())
    staged = stage_source(checkout, {"nested/sample.py": digest(content)}, tmp_path / "attempt")
    with ReviewSource(staged.source_root, json.loads(staged.manifest_path.read_text())) as reader:
        assert reader.read("nested/sample.py") == content
    assert not stat.S_IMODE((staged.source_root / "nested").stat().st_mode) & 0o222


def test_failure_after_partial_copy_removes_whole_attempt(tmp_path):
    checkout = tmp_path / "checkout"
    (checkout / "nested").mkdir(parents=True)
    (checkout / "nested" / "a").write_text("ok")
    with pytest.raises(ReviewSourceError):
        stage_source(
            checkout, {"nested/a": digest("ok"), "z": digest("missing")}, tmp_path / "attempt"
        )
    assert not (tmp_path / "attempt").exists()


@pytest.mark.parametrize("value", ["bad", "a" * 63, "A" * 64, "a" * 64 + "\n"])
def test_invalid_digest_is_rejected(tmp_path, value):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    with pytest.raises(ReviewSourceError, match="INVALID_SOURCE_DIGEST"):
        stage_source(checkout, {"a": value}, tmp_path / "attempt")
    assert not (tmp_path / "attempt").exists()


def test_total_size_is_bounded_and_partial_copy_cleaned(tmp_path, monkeypatch):
    monkeypatch.setattr("sandbox_runtime.review_staging.MAX_SEARCH_BYTES", 3)
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    for name in ["a", "b"]:
        (checkout / name).write_text("ok")
    with pytest.raises(ReviewSourceError, match="SOURCE_SCOPE_TOO_LARGE"):
        stage_source(checkout, {"a": digest("ok"), "b": digest("ok")}, tmp_path / "attempt")
    assert not (tmp_path / "attempt").exists()
