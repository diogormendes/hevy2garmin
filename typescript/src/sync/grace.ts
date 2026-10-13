/**
 * The grace period: hold a workout back until the watch has had time to send
 * its own recording to Garmin.
 *
 * This is the piece that makes merge possible at all. Hevy publishes a workout
 * the moment the user taps finish, but the watch uploads its activity when it
 * next syncs, which is usually minutes later and sometimes much later. A sync
 * that runs in that window finds nothing to match, uploads its own activity,
 * and the user ends up with two records of one session. The grace period is the
 * wait that stops that.
 *
 * Ported from `_workout_within_grace` in `src/hevy2garmin/sync.py`, with the
 * default from `config.py` (`sync.grace_period_minutes`, 120).
 *
 * The wait applies only to unattended runs (cron, auto-sync). A person pressing
 * Sync Now has decided they want it now, so the caller passes `respectGrace`
 * rather than the engine assuming it.
 */
import { toUtcDate } from "../match";

/** `sync.grace_period_minutes` in the Python config. */
export const DEFAULT_GRACE_MINUTES = 120;

/** What the grace check decided, with the numbers behind it for logging. */
export interface GraceCheck {
  /** True when the workout is too new to sync yet. */
  withinGrace: boolean;
  /** Minutes since the workout ended, or null when the end time is unusable. */
  ageMinutes: number | null;
  /** The limit applied, so a caller can log "12 of 120 minutes". */
  graceMinutes: number;
}

/**
 * How long ago a workout ended, in minutes, or null when it cannot be read.
 *
 * A negative value means the end time is in the future, which happens with
 * clock skew between the phone and this machine. That still counts as "too
 * new": waiting is the safe direction, and the wait ends on its own as the
 * clock moves.
 */
export function workoutAgeMinutes(
  workout: { end_time?: unknown; endTime?: unknown },
  now: Date = new Date(),
): number | null {
  const raw = workout.end_time ?? workout.endTime;
  if (typeof raw !== "string" || !raw) return null;
  const end = toUtcDate(raw);
  if (!end) return null;
  return (now.getTime() - end.getTime()) / 60000;
}

/**
 * Whether a workout is still inside its grace period.
 *
 * A grace of 0 or less turns the wait off, which is how a caller disables it
 * without a second flag. A workout with no usable end time is never held back:
 * there is no clock to wait against, and deferring it would defer it forever.
 */
export function checkGracePeriod(
  workout: { end_time?: unknown; endTime?: unknown },
  graceMinutes: number = DEFAULT_GRACE_MINUTES,
  now: Date = new Date(),
): GraceCheck {
  const limit = Number.isFinite(graceMinutes) ? graceMinutes : DEFAULT_GRACE_MINUTES;
  const ageMinutes = workoutAgeMinutes(workout, now);
  if (limit <= 0 || ageMinutes === null) {
    return { withinGrace: false, ageMinutes, graceMinutes: limit };
  }
  return { withinGrace: ageMinutes < limit, ageMinutes, graceMinutes: limit };
}

/** Shorthand when only the decision is wanted. */
export function isWithinGracePeriod(
  workout: { end_time?: unknown; endTime?: unknown },
  graceMinutes: number = DEFAULT_GRACE_MINUTES,
  now: Date = new Date(),
): boolean {
  return checkGracePeriod(workout, graceMinutes, now).withinGrace;
}
