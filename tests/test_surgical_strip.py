"""Surgical exercise-name stripping on a Garmin subcategory rejection (#222).

Regression guard: one exercise Garmin rejects used to blank EVERY exercise name in
the merged activity. Now only the offending name is stripped; the rest are kept.
"""

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from hevy2garmin import merge


def _payload(exercises):
    """exercises: list of (category, name) — one exercise per set."""
    return {
        "exerciseSets": [
            {"order": i, "exercises": [{"category": c, "name": n, "probability": None}]}
            for i, (c, n) in enumerate(exercises)
        ]
    }


def _accepted_names(payload):
    names = {}
    for s in payload["exerciseSets"]:
        for ex in s["exercises"]:
            names[ex["category"]] = ex["name"]
    return names


def test_single_offender_keeps_the_other_names():
    payload = _payload(
        [
            ("BENCH_PRESS", "BARBELL_BENCH_PRESS"),
            ("SHOULDER_PRESS", "BAD_SHOULDER_NAME"),  # the one Garmin rejects
            ("CURL", "BARBELL_BICEPS_CURL"),
            ("TRICEPS_EXTENSION", "CABLE_KICKBACK"),
        ]
    )
    offender = ("SHOULDER_PRESS", "BAD_SHOULDER_NAME")
    accepted = {}

    def fake_push(client, aid, p):
        for s in p["exerciseSets"]:
            for ex in s["exercises"]:
                if (ex["category"], ex["name"]) == offender:  # still named → rejected
                    raise RuntimeError("HTTP 400: Invalid Sub-Category Passed in the request")
        accepted["payload"] = p  # this one landed

    with patch.object(merge, "push_exercise_sets", side_effect=fake_push):
        merge._push_stripping_offenders(None, 123, payload)

    names = _accepted_names(accepted["payload"])
    assert names["SHOULDER_PRESS"] is None  # offender stripped
    assert names["BENCH_PRESS"] == "BARBELL_BENCH_PRESS"  # kept
    assert names["CURL"] == "BARBELL_BICEPS_CURL"  # kept
    assert names["TRICEPS_EXTENSION"] == "CABLE_KICKBACK"  # kept


def test_multiple_offenders_fall_back_to_stripping_all():
    payload = _payload(
        [
            ("BENCH_PRESS", "GOOD_1"),
            ("SHOULDER_PRESS", "BAD_1"),
            ("CURL", "GOOD_2"),
            ("TRICEPS_EXTENSION", "BAD_2"),
        ]
    )
    bad = {("SHOULDER_PRESS", "BAD_1"), ("TRICEPS_EXTENSION", "BAD_2")}
    accepted = {}

    def fake_push(client, aid, p):
        for s in p["exerciseSets"]:
            for ex in s["exercises"]:
                if (ex["category"], ex["name"]) in bad:
                    raise RuntimeError("Invalid Sub-Category")
        accepted["payload"] = p

    with patch.object(merge, "push_exercise_sets", side_effect=fake_push):
        merge._push_stripping_offenders(None, 123, payload)

    # Can't keep any (offenders split across halves) → every name stripped.
    for name in _accepted_names(accepted["payload"]).values():
        assert name is None


def test_single_exercise_strips_that_one():
    payload = _payload([("SHOULDER_PRESS", "BAD")])
    accepted = {}

    def fake_push(client, aid, p):
        ex = p["exerciseSets"][0]["exercises"][0]
        if ex["name"] == "BAD":
            raise RuntimeError("invalid sub-category")
        accepted["payload"] = p

    with patch.object(merge, "push_exercise_sets", side_effect=fake_push):
        merge._push_stripping_offenders(None, 123, payload)

    assert accepted["payload"]["exerciseSets"][0]["exercises"][0]["name"] is None
