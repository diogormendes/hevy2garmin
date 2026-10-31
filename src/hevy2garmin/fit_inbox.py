"""Import new .fit files from a local inbox folder into Garmin Connect.

Designed to work seamlessly with folder sync tools (e.g. Synology Cloud Sync,
Google Drive for Desktop, rclone, Syncthing) mounted into the container or host.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from hevy2garmin.db_interface import Database

logger = logging.getLogger("hevy2garmin")

_IGNORED_DIRS = {"uploaded", "processed", "@eadir", ".synologyworkingdirectory"}


def _is_valid_fit_bytes(data: bytes) -> bool:
    """Return True when bytes carry a valid FIT file header."""
    if len(data) < 14:
        return False
    header_size = data[0]
    if header_size not in (12, 14):
        return False
    return data[8:12] == b".FIT"


def _fit_record_id(data: bytes) -> str:
    """Deterministic sync record ID from the SHA-256 digest of a .fit file."""
    digest = hashlib.sha256(data).hexdigest()[:16]
    return f"fit:{digest}"


def _is_duplicate_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "409" in text or "duplicate" in text


def _upload_fit(garmin_client: Any, fit_path: Path) -> dict[str, Any]:
    from hevy2garmin.garmin import upload_fit

    return upload_fit(garmin_client, fit_path)


def discover_fit_files(inbox_dir: str | Path) -> list[Path]:
    """Return all candidate .fit files in ``inbox_dir`` sorted oldest-first."""
    root = Path(inbox_dir).expanduser()
    if not root.is_dir():
        return []

    candidates: list[Path] = []
    for entry in root.iterdir():
        if entry.name.startswith(".") or entry.name.lower() in _IGNORED_DIRS:
            continue
        if entry.is_file() and entry.suffix.lower() == ".fit":
            candidates.append(entry)

    candidates.sort(key=lambda p: (p.stat().st_mtime, p.name))
    return candidates


def sync_fit_inbox(
    inbox_dir: str | Path,
    *,
    garmin_client: Any = None,
    database: Database | None = None,
    dry_run: bool = False,
    archive_uploaded: bool = False,
) -> dict[str, int]:
    """Scan ``inbox_dir`` for unsynced ``.fit`` files and upload them to Garmin Connect.

    Args:
        inbox_dir: Directory containing incoming ``.fit`` files.
        garmin_client: Authenticated Garmin client (required unless ``dry_run=True``).
        database: Database instance for deduplication (resolved automatically if None).
        dry_run: When True, log discovered unsynced files without uploading.
        archive_uploaded: When True, move processed ``.fit`` files into ``<inbox_dir>/uploaded/``.

    Returns:
        Stats dict with keys ``found``, ``synced``, ``skipped``, ``duplicates``, ``failed``.
    """
    from hevy2garmin import db

    store = database or db.get_db()
    stats = {"found": 0, "synced": 0, "skipped": 0, "duplicates": 0, "failed": 0}

    root = Path(inbox_dir).expanduser()
    if not root.exists():
        logger.warning("FIT inbox directory does not exist: %s", root)
        return stats

    files = discover_fit_files(root)
    if not files:
        logger.info("FIT inbox (%s): no .fit files found", root)
        return stats

    for fit_path in files:
        try:
            data = fit_path.read_bytes()
        except OSError as exc:
            logger.warning("Could not read %s: %s", fit_path.name, exc)
            stats["failed"] += 1
            continue

        if not _is_valid_fit_bytes(data):
            logger.warning(
                "Skipping %s — incomplete or invalid .fit header (still syncing?)",
                fit_path.name,
            )
            stats["skipped"] += 1
            continue

        rec_id = _fit_record_id(data)
        if store.is_synced(rec_id):
            logger.debug("Skipping %s (%s) — already uploaded", fit_path.name, rec_id)
            stats["skipped"] += 1
            if archive_uploaded and not dry_run:
                _archive_file(fit_path, root / "uploaded")
            continue

        stats["found"] += 1
        title = fit_path.stem

        if dry_run:
            logger.info("  [dry-run] Would upload %s (%s)", fit_path.name, rec_id)
            stats["synced"] += 1
            continue

        if garmin_client is None:
            raise RuntimeError("garmin_client is required when dry_run is False")

        logger.info("Uploading inbox FIT %s...", fit_path.name)
        try:
            result = _upload_fit(garmin_client, fit_path)
            activity_id = result.get("activity_id")
            store.mark_synced(
                rec_id,
                garmin_activity_id=str(activity_id) if activity_id else None,
                title=title,
                sync_method="fit_inbox",
            )
            stats["synced"] += 1
            logger.info("  ✓ Uploaded %s (activity_id=%s)", fit_path.name, activity_id)
            if archive_uploaded:
                _archive_file(fit_path, root / "uploaded")
        except Exception as exc:  # noqa: BLE001
            if _is_duplicate_error(exc):
                store.mark_synced(
                    rec_id,
                    garmin_activity_id=None,
                    title=title,
                    sync_method="fit_inbox_duplicate",
                )
                stats["duplicates"] += 1
                logger.info("  • %s already exists on Garmin — marked as synced", fit_path.name)
                if archive_uploaded:
                    _archive_file(fit_path, root / "uploaded")
            else:
                stats["failed"] += 1
                logger.error("  ✗ Failed to upload %s: %s", fit_path.name, str(exc)[:300])

    logger.info(
        "FIT inbox complete: %d uploaded, %d duplicates, %d skipped, %d failed",
        stats["synced"],
        stats["duplicates"],
        stats["skipped"],
        stats["failed"],
    )
    return stats


def _archive_file(src: Path, dest_dir: Path) -> None:
    """Best-effort move of a processed .fit file into ``dest_dir``."""
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        target = dest_dir / src.name
        shutil.move(str(src), str(target))
    except OSError as exc:
        logger.debug("Could not move %s to %s: %s", src.name, dest_dir, exc)
