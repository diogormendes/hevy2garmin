"""Tests for the Garmin login rate-limit cooldown (exponential backoff)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from hevy2garmin.ratelimit import (
    _KEY,
    clear_rate_limit,
    cooldown_remaining,
    format_cooldown,
    record_rate_limit,
)


class FakeDB:
    """In-memory app_config store."""

    def __init__(self):
        self._c = {}

    def get_app_config(self, key):
        return self._c.get(key)

    def set_app_config(self, key, value):
        self._c[key] = value


def test_first_hit_is_two_hours():
    db = FakeDB()
    assert record_rate_limit(db) == 2 * 3600
    # ~2h remaining (allow a few seconds of clock drift)
    assert 2 * 3600 - 60 < cooldown_remaining(db) <= 2 * 3600


def test_backoff_doubles_each_repeat():
    db = FakeDB()
    assert record_rate_limit(db) == 2 * 3600  # hit 1
    assert record_rate_limit(db) == 4 * 3600  # hit 2
    assert record_rate_limit(db) == 8 * 3600  # hit 3


def test_backoff_caps_at_24h():
    db = FakeDB()
    last = 0
    for _ in range(10):
        last = record_rate_limit(db)
    assert last == 24 * 3600


def test_no_state_means_no_cooldown():
    assert cooldown_remaining(FakeDB()) == 0


def test_clear_resets_cooldown_and_backoff():
    db = FakeDB()
    record_rate_limit(db)
    assert cooldown_remaining(db) > 0
    clear_rate_limit(db)
    assert cooldown_remaining(db) == 0
    # next hit starts back at the 2h base, not the escalated window
    assert record_rate_limit(db) == 2 * 3600


def test_expired_cooldown_reports_zero():
    db = FakeDB()
    db.set_app_config(
        _KEY,
        {
            "until": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
            "hits": 1,
        },
    )
    assert cooldown_remaining(db) == 0


def test_format_cooldown_hours_and_minutes():
    assert format_cooldown(6300) == "about 1h 45m"


def test_format_cooldown_minutes_only():
    assert format_cooldown(300) == "about 5m"


def test_format_cooldown_exact_hours():
    assert format_cooldown(7200) == "about 2h"


def test_storage_failure_never_raises():
    class BrokenDB:
        def get_app_config(self, key):
            raise RuntimeError("db down")

        def set_app_config(self, key, value):
            raise RuntimeError("db down")

    db = BrokenDB()
    # must not raise
    assert record_rate_limit(db) == 2 * 3600
    assert cooldown_remaining(db) == 0
    clear_rate_limit(db)
