"""ISO-8601 timestamp parsing that behaves the same on Python 3.10 and 3.11+.

``datetime.fromisoformat`` on Python 3.10 only accepts 0, 3, or 6 fractional-second
digits and requires a ``T`` separator. Garmin/Surfr timestamps can carry a single
fractional digit (e.g. ``2026-03-15T18:02:00.0+00:00``) or a space separator, which
parses fine on 3.11+ but raises ``ValueError`` on 3.10. The repo supports 3.10
(``requires-python >=3.10``), so all timestamp parsing goes through ``parse_iso``.
"""

from __future__ import annotations

import re
from datetime import datetime

_FRAC = re.compile(r"\.(\d+)")


def parse_iso(value: str) -> datetime:
    """Parse an ISO-8601 timestamp, tolerant of a space date/time separator, a
    trailing ``Z``, and any fractional-second width (padded to 6 digits so 3.10
    parses it too)."""
    s = value.replace(" ", "T").replace("Z", "+00:00")
    s = _FRAC.sub(lambda m: "." + (m.group(1) + "000000")[:6], s)
    return datetime.fromisoformat(s)
