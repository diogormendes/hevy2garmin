/**
 * Tests for the merge matcher (#571).
 *
 * Every rejection rule gets its own test. The engine previously matched on an
 * exact start time, which finds nothing when a watch is started by hand, so
 * merge could never fire. These cases are the difference between "merge works"
 * and "merge silently does nothing", which is how #495 and #565 were reported.
 */
import { describe, it, expect } from "vitest";
import {
  findMergeMatch,
  mergeSearchRange,
  DEFAULT_OVERLAP_THRESHOLD,
  DEFAULT_MAX_DRIFT_MINUTES,
  type CandidateActivity,
} from "../src/merge-match";

// A 60-minute workout on a fixed day, and a "now" well after it.
const WORKOUT = { start_time: "2026-09-15T10:00:00Z", end_time: "2026-09-15T11:00:00Z" };
const NOW = new Date("2026-09-15T12:00:00Z");

function act(over: Partial<CandidateActivity> = {}): CandidateActivity {
  return {
    activityId: 1,
    duration: 3600,
    startTimeGMT: "2026-09-15 10:00:00",
    activityType: { typeKey: "strength_training" },
    ...over,
  };
}

describe("findMergeMatch", () => {
  it("matches a watch activity that starts a few minutes late, which exact-time matching never could", () => {
    // The whole point: the watch was started 4 minutes after the Hevy workout.
    const m = findMergeMatch(WORKOUT, [act({ startTimeGMT: "2026-09-15 10:04:00" })], { now: NOW });
    expect(m).not.toBeNull();
    expect(m!.activity.activityId).toBe(1);
    expect(m!.driftMinutes).toBeCloseTo(4, 5);
    expect(m!.overlapPct).toBeGreaterThan(DEFAULT_OVERLAP_THRESHOLD);
  });

  it("rejects an activity of the wrong type, so a climbing session is not merged into", () => {
    const climbing = act({ activityType: { typeKey: "indoor_climbing" } });
    expect(findMergeMatch(WORKOUT, [climbing], { now: NOW })).toBeNull();
    // ...unless the user opted that type in, which is what merge_activity_types is for.
    const opted = findMergeMatch(WORKOUT, [climbing], {
      now: NOW,
      activityTypes: ["strength_training", "indoor_climbing"],
    });
    expect(opted).not.toBeNull();
  });

  it("rejects an activity still in progress, which Garmin marks with duration 0", () => {
    expect(findMergeMatch(WORKOUT, [act({ duration: 0 })], { now: NOW })).toBeNull();
    expect(findMergeMatch(WORKOUT, [act({ duration: undefined })], { now: NOW })).toBeNull();
  });

  it("rejects an activity that has not finished yet, allowing five minutes of clock skew", () => {
    // Ends 30 min after "now": not finished.
    const future = act({ startTimeGMT: "2026-09-15 11:30:00", duration: 3600 });
    expect(findMergeMatch(WORKOUT, [future], { now: NOW })).toBeNull();
    // Ends 4 minutes after "now": inside the skew margin, so still eligible.
    const justOver = act({ startTimeGMT: "2026-09-15 10:04:00", duration: 3600 + 4 * 60 });
    expect(findMergeMatch(WORKOUT, [justOver], { now: NOW })).not.toBeNull();
  });

  it("rejects too little overlap, and accepts once the threshold is lowered", () => {
    // 30 of 60 minutes = 50% overlap, under the 70% default.
    const half = act({ startTimeGMT: "2026-09-15 10:00:00", duration: 1800 });
    expect(findMergeMatch(WORKOUT, [half], { now: NOW })).toBeNull();
    const lowered = findMergeMatch(WORKOUT, [half], { now: NOW, overlapThreshold: 0.4 });
    expect(lowered).not.toBeNull();
    expect(lowered!.overlapPct).toBeCloseTo(0.5, 5);
  });

  it("rejects too much start drift even when the overlap is fine", () => {
    // Starts 25 min early and runs long: overlap is high, drift is over the 20 min limit.
    const drifted = act({ startTimeGMT: "2026-09-15 09:35:00", duration: 3600 + 25 * 60 });
    expect(findMergeMatch(WORKOUT, [drifted], { now: NOW })).toBeNull();
    const allowed = findMergeMatch(WORKOUT, [drifted], { now: NOW, maxDriftMinutes: 30 });
    expect(allowed).not.toBeNull();
    expect(allowed!.driftMinutes).toBeCloseTo(25, 5);
    expect(DEFAULT_MAX_DRIFT_MINUTES).toBe(20);
  });

  it("prefers overlap over drift, matching the Python score", () => {
    // A starts on time but stops early: 45 of 60 min overlap, no drift.
    // B starts 6 min late and runs an hour: 54 of 60 min overlap, 6 min drift.
    const a = act({ activityId: 10, startTimeGMT: "2026-09-15 10:00:00", duration: 2700 });
    const b = act({ activityId: 20, startTimeGMT: "2026-09-15 10:06:00", duration: 3600 });
    const m = findMergeMatch(WORKOUT, [a, b], { now: NOW });
    // A scores 75 - 0 = 75. B scores 90 - 3 = 87, so the better overlap wins
    // despite the drift penalty, which is the Python's ordering.
    expect(m!.activity.activityId).toBe(20);
    expect(m!.overlapPct).toBeCloseTo(0.9, 5);
    expect(m!.score).toBeCloseTo(87, 5);
  });

  it("returns null for a workout with no usable times, rather than throwing", () => {
    expect(findMergeMatch({}, [act()], { now: NOW })).toBeNull();
    expect(findMergeMatch({ start_time: "nonsense", end_time: "also nonsense" }, [act()], { now: NOW })).toBeNull();
    // An end before the start is not a zero-length workout, it is bad data.
    expect(
      findMergeMatch({ start_time: "2026-09-15T11:00:00Z", end_time: "2026-09-15T10:00:00Z" }, [act()], { now: NOW }),
    ).toBeNull();
  });

  it("accepts Garmin's space-separated GMT strings and falls back to startTimeLocal", () => {
    const spaced = findMergeMatch(WORKOUT, [act({ startTimeGMT: "2026-09-15 10:00:00" })], { now: NOW });
    expect(spaced).not.toBeNull();
    const localOnly = findMergeMatch(
      WORKOUT,
      [act({ startTimeGMT: undefined, startTimeLocal: "2026-09-15 10:00:00" })],
      { now: NOW },
    );
    expect(localOnly).not.toBeNull();
  });

  it("returns null when there are no candidates at all", () => {
    expect(findMergeMatch(WORKOUT, [], { now: NOW })).toBeNull();
  });
});

describe("mergeSearchRange", () => {
  it("pads two hours either side so an late-evening session reaches the next day", () => {
    const r = mergeSearchRange({ start_time: "2026-09-15T23:30:00Z", end_time: "2026-09-16T00:30:00Z" });
    expect(r).toEqual({ start: "2026-09-15", end: "2026-09-16" });
  });

  it("returns null when the workout has no usable times", () => {
    expect(mergeSearchRange({})).toBeNull();
  });
});
