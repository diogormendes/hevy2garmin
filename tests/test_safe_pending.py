"""Safety invariants for parked Garmin upload operations."""

from pathlib import Path
from unittest.mock import MagicMock, patch

from hevy2garmin.db_sqlite import SQLiteDatabase
from hevy2garmin.sync import finalize_pending, reconcile_pending


def test_unique_pending_claim(tmp_path: Path) -> None:
    store = SQLiteDatabase(tmp_path / "sync.db")
    assert store.claim_pending("w1", {"title": "Push"}) is True
    assert store.claim_pending("w1", {"title": "Other"}) is False
    assert store.get_pending("w1")["payload"]["title"] == "Push"


def test_complete_is_terminal_and_removes_pending(tmp_path: Path) -> None:
    store = SQLiteDatabase(tmp_path / "sync.db")
    store.claim_pending("w1", {})
    store.complete_pending("w1", {"garmin_activity_id": "123", "title": "Push"})
    assert store.get_pending("w1") is None
    assert store.is_synced("w1") is True
    assert store.get_recent_synced(1)[0]["status"] == "success"


def test_manual_resolution_removes_pending(tmp_path: Path) -> None:
    store = SQLiteDatabase(tmp_path / "sync.db")
    store.claim_pending("w1", {})
    store.resolve_terminal(
        "w1", status="manual", garmin_activity_id="123", reason="verified", source="manual"
    )
    assert store.get_pending("w1") is None
    row = store.get_recent_synced(1)[0]
    assert row["status"] == "manual"
    assert row["resolution_reason"] == "verified"


def test_same_id_never_deletes_replacement(tmp_path: Path) -> None:
    store = SQLiteDatabase(tmp_path / "sync.db")
    store.claim_pending("w1", {"title": "Push", "description_enabled": False})
    store.update_pending(
        "w1",
        phase="finalizing",
        next_step="delete",
        garmin_activity_id="42",
        watch_activity_id="42",
    )
    client = MagicMock()
    with patch("hevy2garmin.sync.delete_activity") as delete:
        result = finalize_pending(store, client, store.get_pending("w1"))
    assert result.status == "needs_review"
    delete.assert_not_called()
    assert store.get_pending("w1")["phase"] == "needs_review"


def test_finalize_null_watch_id_skips_delete(tmp_path: Path) -> None:
    store = SQLiteDatabase(tmp_path / "sync.db")
    store.claim_pending("w1", {"title": "Push", "description_enabled": False})
    store.update_pending(
        "w1",
        phase="finalizing",
        next_step="delete",
        garmin_activity_id="42",
        watch_activity_id=None,
    )
    with patch("hevy2garmin.sync.delete_activity") as delete:
        result = finalize_pending(store, MagicMock(), store.get_pending("w1"))
    assert result.status == "synced"
    delete.assert_not_called()
    assert store.get_pending("w1") is None
    assert store.is_synced("w1") is True


def test_reconcile_without_candidate_never_uploads(tmp_path: Path) -> None:
    store = SQLiteDatabase(tmp_path / "sync.db")
    workout = {"start_time": "2026-01-01T10:00:00Z", "end_time": "2026-01-01T11:00:00Z"}
    store.claim_pending("w1", {"workout": workout})
    store.update_pending("w1", phase="processing", pre_upload_ids=["10"])
    with (
        patch("hevy2garmin.sync.activities_for_workout", return_value=[]),
        patch("hevy2garmin.sync.upload_fit") as upload,
    ):
        result = reconcile_pending(store, MagicMock(), "w1")
    assert result.status == "processing"
    upload.assert_not_called()


def test_reconcile_refuses_snapshot_without_recovery_evidence(tmp_path: Path) -> None:
    store = SQLiteDatabase(tmp_path / "sync.db")
    workout = {"start_time": "2026-01-01T10:00:00Z", "end_time": "2026-01-01T11:00:00Z"}
    store.claim_pending("w1", {"workout": workout})
    candidate = {
        "activityId": 20,
        "manufacturer": "DEVELOPMENT",
        "activityType": {"typeKey": "strength_training"},
        "startTimeGMT": "2026-01-01 10:00:00",
    }
    with (
        patch("hevy2garmin.sync.activities_for_workout", return_value=[candidate]) as activities,
        patch("hevy2garmin.sync.rename_activity") as rename,
        patch("hevy2garmin.sync.upload_fit") as upload,
    ):
        first = reconcile_pending(store, MagicMock(), "w1")
        second = reconcile_pending(store, MagicMock(), "w1")
    assert first.status == "needs_review"
    assert second.status == "needs_review"
    activities.assert_not_called()
    rename.assert_not_called()
    upload.assert_not_called()
    pending = store.get_pending("w1")
    assert pending["phase"] == "needs_review"
    assert "refusing snapshot adoption" in pending["last_error"]


def test_reconcile_recovers_empty_snapshot_with_matching_candidate(tmp_path: Path) -> None:
    store = SQLiteDatabase(tmp_path / "sync.db")
    workout = {"start_time": "2026-01-01T10:00:00Z", "end_time": "2026-01-01T11:00:00Z"}
    store.claim_pending("w1", {"workout": workout, "title": "Push", "description_enabled": False})
    store.update_pending("w1", phase="processing", pre_upload_ids=[], attempt_count=1)
    candidate = {
        "activityId": 20,
        "manufacturer": "DEVELOPMENT",
        "activityType": {"typeKey": "strength_training"},
        "startTimeGMT": "2026-01-01 10:05:00",
    }
    with (
        patch("hevy2garmin.sync.activities_for_workout", return_value=[candidate]),
        patch("hevy2garmin.sync.rename_activity") as rename,
        patch("hevy2garmin.sync.upload_fit") as upload,
    ):
        result = reconcile_pending(store, MagicMock(), "w1")
    assert result.status == "synced"
    rename.assert_called_once()
    upload.assert_not_called()
    assert store.get_pending("w1") is None
    assert store.get_garmin_id("w1") == "20"


def test_reconcile_rejects_foreign_candidate_outside_start_window(tmp_path: Path) -> None:
    store = SQLiteDatabase(tmp_path / "sync.db")
    workout = {"start_time": "2026-01-01T10:00:00Z", "end_time": "2026-01-01T11:00:00Z"}
    store.claim_pending("w1", {"workout": workout, "title": "Push", "description_enabled": False})
    store.update_pending("w1", phase="processing", pre_upload_ids=["10"], attempt_count=1)
    candidate = {
        "activityId": 20,
        "manufacturer": "DEVELOPMENT",
        "activityType": {"typeKey": "strength_training"},
        "startTimeGMT": "2026-01-01 12:00:00",
    }
    with (
        patch("hevy2garmin.sync.activities_for_workout", return_value=[candidate]),
        patch("hevy2garmin.sync.rename_activity") as rename,
        patch("hevy2garmin.sync.upload_fit") as upload,
    ):
        result = reconcile_pending(store, MagicMock(), "w1")
    assert result.status == "needs_review"
    rename.assert_not_called()
    upload.assert_not_called()
    assert store.get_pending("w1")["garmin_activity_id"] is None


def test_reconcile_rejects_candidate_with_null_activity_type(tmp_path: Path) -> None:
    store = SQLiteDatabase(tmp_path / "sync.db")
    workout = {"start_time": "2026-01-01T10:00:00Z", "end_time": "2026-01-01T11:00:00Z"}
    store.claim_pending("w1", {"workout": workout, "title": "Push", "description_enabled": False})
    store.update_pending("w1", phase="processing", pre_upload_ids=["10"], attempt_count=1)
    candidate = {
        "activityId": 20,
        "manufacturer": "DEVELOPMENT",
        "activityType": None,
        "startTimeGMT": "2026-01-01 10:00:00",
    }
    with (
        patch("hevy2garmin.sync.activities_for_workout", return_value=[candidate]),
        patch("hevy2garmin.sync.rename_activity") as rename,
        patch("hevy2garmin.sync.upload_fit") as upload,
    ):
        result = reconcile_pending(store, MagicMock(), "w1")
    assert result.status == "needs_review"
    rename.assert_not_called()
    upload.assert_not_called()
    assert store.get_pending("w1")["garmin_activity_id"] is None
