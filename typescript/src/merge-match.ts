/**
 * Find the watch-recorded Garmin activity a Hevy workout belongs to.
 *
 * This is the matcher the MERGE path needs, and it is a different question from
 * the one `match.ts` answers. That one asks "has this workout already been
 * uploaded", and a timestamp is enough. This one asks "which activity was the
 * user's watch recording of this same session", which a timestamp alone cannot
 * decide: the watch is started and stopped by hand, so it drifts from Hevy by
 * minutes at both ends. Matching on an exact start time, as the engine did
 * before, finds nothing unless both clocks agree to the second.
 *
 * Ported from `find_matching_garmin_activity` in `src/hevy2garmin/garmin.py`.
 * Scoring and every rejection rule are kept identical, so a workout that merged
 * under the Python dashboard merges here too.
 *
 * Pure by design: the caller fetches the candidate activities and passes them
 * in. That keeps the rules testable without a Garmin account, which is the only
 * way to cover the rejection paths at all.
 */
import { toUtcDate } from "./match";

/** The subset of a Garmin activity the matcher reads. */
export interface CandidateActivity {
  activityId: number;
  /** Seconds. Garmin only sets this above 0 once the activity is saved. */
  duration?: number;
  startTimeGMT?: string;
  startTimeLocal?: string;
  activityType?: { typeKey?: string };
  activityName?: string;
  /** FIT manufacturer. Our own uploads are DEVELOPMENT; anything else is a device. */
  manufacturer?: string;
}

export interface MergeMatchOptions {
  /** Fraction of the Hevy workout that must be covered by the activity. */
  overlapThreshold?: number;
  /** How far the two start times may differ before the pair is rejected. */
  maxDriftMinutes?: number;
  /** Only these Garmin typeKeys are eligible. */
  activityTypes?: Iterable<string>;
  /** Injectable clock, so the "not finished yet" rule is testable. */
  now?: Date;
}

/**
 * The timestamps a match needs. Nullable because a Hevy workout row carries
 * nulls, and every reader here already treats a missing time as "unknown".
 */
export interface TimedWorkout {
  start_time?: string | null;
  startTime?: string | null;
  end_time?: string | null;
  endTime?: string | null;
}

export interface MergeMatch {
  activity: CandidateActivity;
  /** Fraction of the workout the activity covers, 0..1. */
  overlapPct: number;
  /** Absolute start-time difference, in minutes. */
  driftMinutes: number;
  score: number;
}

export const DEFAULT_OVERLAP_THRESHOLD = 0.7;
export const DEFAULT_MAX_DRIFT_MINUTES = 20;
export const DEFAULT_ACTIVITY_TYPES = ["strength_training"];

/**
 * Garmin sets `duration` only once an activity is saved, but a clock that is
 * slightly ahead can still make a finished activity look like it ends in the
 * future. Five minutes of margin, matching the Python.
 */
const FUTURE_MARGIN_MS = 5 * 60 * 1000;

/**
 * The best eligible activity for this workout, or null.
 *
 * An activity qualifies only if ALL of these hold, and each has its own test:
 *  - its typeKey is in `activityTypes` (a climbing session recorded at the same
 *    time is not a strength session, and must not be merged into),
 *  - it has a duration above 0, so it is saved rather than in progress,
 *  - it has finished, allowing five minutes of clock skew,
 *  - it covers at least `overlapThreshold` of the workout,
 *  - its start is within `maxDriftMinutes` of the workout's.
 *
 * Among the survivors, overlap dominates and drift is a small penalty:
 * `score = overlapPct * 100 - driftMinutes * 0.5`.
 */
export function findMergeMatch(
  workout: TimedWorkout,
  activities: CandidateActivity[],
  options: MergeMatchOptions = {},
): MergeMatch | null {
  const overlapThreshold = options.overlapThreshold ?? DEFAULT_OVERLAP_THRESHOLD;
  const maxDriftMinutes = options.maxDriftMinutes ?? DEFAULT_MAX_DRIFT_MINUTES;
  const types = new Set(options.activityTypes ?? DEFAULT_ACTIVITY_TYPES);
  const now = options.now ?? new Date();

  const hevyStart = toUtcDate(workout.start_time || workout.startTime || "");
  const hevyEnd = toUtcDate(workout.end_time || workout.endTime || "");
  if (!hevyStart || !hevyEnd) return null;

  const hevyDurationS = (hevyEnd.getTime() - hevyStart.getTime()) / 1000;
  if (hevyDurationS <= 0) return null;

  let best: MergeMatch | null = null;

  for (const act of activities) {
    if (!types.has(act.activityType?.typeKey ?? "")) continue;

    const durationS = act.duration ?? 0;
    if (durationS <= 0) continue;

    const actStart = toUtcDate(act.startTimeGMT || act.startTimeLocal || "");
    if (!actStart) continue;
    const actEnd = new Date(actStart.getTime() + durationS * 1000);

    if (actEnd.getTime() > now.getTime() + FUTURE_MARGIN_MS) continue;

    const overlapStart = Math.max(hevyStart.getTime(), actStart.getTime());
    const overlapEnd = Math.min(hevyEnd.getTime(), actEnd.getTime());
    const overlapS = Math.max(0, (overlapEnd - overlapStart) / 1000);
    const overlapPct = overlapS / hevyDurationS;
    if (overlapPct < overlapThreshold) continue;

    const driftMinutes = Math.abs(actStart.getTime() - hevyStart.getTime()) / 60000;
    if (driftMinutes > maxDriftMinutes) continue;

    const score = overlapPct * 100 - driftMinutes * 0.5;
    if (!best || score > best.score) best = { activity: act, overlapPct, driftMinutes, score };
  }

  return best;
}

/**
 * The date range to ask Garmin for, as YYYY-MM-DD. Two hours either side of the
 * workout, so a session that starts late in the evening still reaches the next
 * day's activities.
 */
export function mergeSearchRange(
  workout: TimedWorkout,
): { start: string; end: string } | null {
  const hevyStart = toUtcDate(workout.start_time || workout.startTime || "");
  const hevyEnd = toUtcDate(workout.end_time || workout.endTime || "");
  if (!hevyStart || !hevyEnd) return null;
  const pad = 2 * 3600 * 1000;
  return {
    start: new Date(hevyStart.getTime() - pad).toISOString().slice(0, 10),
    end: new Date(hevyEnd.getTime() + pad).toISOString().slice(0, 10),
  };
}
