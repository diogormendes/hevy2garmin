/**
 * A start date, below which Hevy workouts are not sync candidates (#647).
 *
 * Anyone who used Hevy before finding this tool has a back catalogue that shows
 * as pending for ever. Many of those workouts are already on Garmin, entered by
 * hand, so the tool offers to upload things the user has already dealt with and
 * there is no way to say "start from here". Clearing them one at a time with
 * Mark as synced is not an answer at several hundred.
 *
 * Applied in the app's own `fetchWorkouts` rather than in the engine, so the
 * engine sees a shorter list and every path that reads candidates honours it
 * without being told. Putting it in the engine would also mean a package release
 * and a pin bump before the dashboard saw any of it.
 *
 * Nothing is deleted or marked. Clearing the date brings the old workouts back
 * as candidates, which is why this filters rather than writes.
 */

/** A stored value that is not a date means "no window", never "drop everything". */
export function parseStartDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  // Compared against instants, so anchor at the start of that day in UTC. A
  // workout ON the start date is kept: the user picked the day they began.
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Drop workouts that finished before the start date.
 *
 * A workout with no parseable start time is KEPT. Hiding something because its
 * timestamp could not be read would be a silent data loss, and the user would
 * have no way to discover it.
 */
export function withinSyncWindow<T>(workouts: readonly T[], startDate: Date | null): T[] {
  if (!startDate) return [...workouts];
  return workouts.filter((w) => {
    const raw = (w as { start_time?: unknown }).start_time;
    if (typeof raw !== "string" || !raw.trim()) return true;
    const t = new Date(raw);
    if (Number.isNaN(t.getTime())) return true;
    return t.getTime() >= startDate.getTime();
  });
}
