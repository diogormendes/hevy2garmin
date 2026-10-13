"""parse_iso must behave identically on Python 3.10 and 3.11+ (#229).

Python 3.10's datetime.fromisoformat only accepts 0/3/6 fractional-second digits
and a 'T' separator; Garmin/Surfr timestamps can have a single fractional digit or
a space separator. parse_iso normalizes both.
"""

from datetime import datetime, timezone

from hevy2garmin._isotime import parse_iso


def test_single_digit_fraction():
    # The exact case that raised ValueError on 3.10 (surfaced by PR #228).
    dt = parse_iso("2026-03-15T18:02:00.0+00:00")
    assert dt == datetime(2026, 3, 15, 18, 2, 0, tzinfo=timezone.utc)


def test_various_fractional_widths():
    assert parse_iso("2026-03-15T18:02:00.5+00:00").microsecond == 500000
    assert parse_iso("2026-03-15T18:02:00.123+00:00").microsecond == 123000
    assert parse_iso("2026-03-15T18:02:00.123456+00:00").microsecond == 123456
    # more than 6 digits is truncated to 6, not rejected
    assert parse_iso("2026-03-15T18:02:00.1234567+00:00").microsecond == 123456


def test_no_fraction():
    assert parse_iso("2026-03-15T18:02:00+00:00") == datetime(
        2026, 3, 15, 18, 2, tzinfo=timezone.utc
    )


def test_space_separator_and_z():
    # Garmin often uses a space separator and a Z suffix.
    dt = parse_iso("2026-03-15 18:02:00Z")
    assert dt == datetime(2026, 3, 15, 18, 2, tzinfo=timezone.utc)


def test_naive_when_no_offset():
    # No offset -> naive datetime (unchanged behavior).
    dt = parse_iso("2026-03-15T18:02:00")
    assert dt.tzinfo is None
