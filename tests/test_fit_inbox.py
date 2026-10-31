"""Tests for local FIT inbox folder import (hevy2garmin.fit_inbox)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from hevy2garmin.fit_inbox import _fit_record_id, _is_valid_fit_bytes, discover_fit_files, sync_fit_inbox

VALID_FIT_BYTES = b"\x0e\x10\x00\x00\x00\x00\x00\x00.FIT\x00\x00\x01\x02\x03\x04"


def test_is_valid_fit_bytes() -> None:
    assert _is_valid_fit_bytes(VALID_FIT_BYTES) is True
    assert _is_valid_fit_bytes(b"too short") is False
    assert _is_valid_fit_bytes(b"\x0e\x10\x00\x00\x00\x00\x00\x00NOPE\x00\x00") is False


def test_discover_fit_files_ignores_hidden_and_archive(tmp_path: Path) -> None:
    (tmp_path / "workout1.fit").write_bytes(VALID_FIT_BYTES)
    (tmp_path / "workout2.FIT").write_bytes(VALID_FIT_BYTES)
    (tmp_path / ".partial.fit").write_bytes(VALID_FIT_BYTES)
    (tmp_path / "notes.txt").write_text("ignore")
    uploaded_dir = tmp_path / "uploaded"
    uploaded_dir.mkdir()
    (uploaded_dir / "old.fit").write_bytes(VALID_FIT_BYTES)

    found = [p.name for p in discover_fit_files(tmp_path)]
    assert set(found) == {"workout1.fit", "workout2.FIT"}


def test_sync_fit_inbox_uploads_and_deduplicates(tmp_path: Path) -> None:
    fit_file = tmp_path / "morning_ride.fit"
    fit_file.write_bytes(VALID_FIT_BYTES)

    synced_ids: set[str] = set()
    store = MagicMock()
    store.is_synced.side_effect = lambda rid: rid in synced_ids
    store.mark_synced.side_effect = lambda rid, **kw: synced_ids.add(rid)

    client = MagicMock()
    with patch("hevy2garmin.fit_inbox._upload_fit", return_value={"activity_id": 99999}) as mock_upload:
        stats1 = sync_fit_inbox(tmp_path, garmin_client=client, database=store)
        assert stats1 == {"found": 1, "synced": 1, "skipped": 0, "duplicates": 0, "failed": 0}
        assert mock_upload.call_count == 1
        assert _fit_record_id(VALID_FIT_BYTES) in synced_ids

        # Second run skips already-uploaded file
        stats2 = sync_fit_inbox(tmp_path, garmin_client=client, database=store)
        assert stats2 == {"found": 0, "synced": 0, "skipped": 1, "duplicates": 0, "failed": 0}
        assert mock_upload.call_count == 1


def test_sync_fit_inbox_archives_when_enabled(tmp_path: Path) -> None:
    fit_file = tmp_path / "run.fit"
    fit_file.write_bytes(VALID_FIT_BYTES)

    store = MagicMock()
    store.is_synced.return_value = False
    client = MagicMock()

    with patch("hevy2garmin.fit_inbox._upload_fit", return_value={"activity_id": 12345}):
        stats = sync_fit_inbox(
            tmp_path, garmin_client=client, database=store, archive_uploaded=True
        )
        assert stats["synced"] == 1
        assert not fit_file.exists()
        assert (tmp_path / "uploaded" / "run.fit").exists()
