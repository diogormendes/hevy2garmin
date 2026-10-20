/**
 * Sync a Hevy routine to Garmin as a planned workout, and schedule it on a date.
 * Ports the Garmin side of the Python routine sync:
 *   - create_workout:  POST /workout-service/workout
 *   - schedule_workout: POST /workout-service/schedule/{workoutId}
 * Both are POSTs, so they use the GarminClient's `post`. Unschedule/delete are
 * DELETE requests, which garmin-auth's client does not expose yet — those are
 * left for a package update.
 *
 * Injectable Garmin client factory for tests. The reverse-engineered Garmin
 * planned-workout payload is validated only against a real export (see
 * garmin-workout); a live smoke-test confirms Garmin accepts it.
 */
import type { GarminClient } from "garmin-auth";
import { getGarminClient } from "./garmin-upload";
import { garminDelete, GarminDeleteError } from "./garmin-delete";
import { routineToGarminWorkout, type HevyRoutine, type WorkoutBuildOptions } from "./garmin-workout";
import {
  deleteGarminWorkout,
  listGarminWorkouts,
  staleWorkoutIds,
  workoutContentHash,
  type GarminLibraryWorkout,
} from "./garmin-workout-library";
import { getDb } from "./db";
import { loadSyncSettings } from "./sync-settings";

type Sql = ReturnType<typeof getDb>;

interface Opts extends WorkoutBuildOptions {
  garminClientFactory?: () => Promise<GarminClient>;
  /** Re-create even when the content hash says nothing changed. */
  force?: boolean;
  /** Test seam: today's date (YYYY-MM-DD) in the user's zone. */
  today?: string;
}

/** Today's date (YYYY-MM-DD) in this zone, or in UTC when none is set or it is not valid. */
export function todayInZone(timeZone: string | undefined, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Whether Garmin no longer has this workout. Only a definite 404 counts: any other
 * failure is "unknown", and the caller keeps what it would have done (#729).
 */
async function workoutGoneOnGarmin(client: GarminClient, workoutId: string | null): Promise<boolean> {
  if (workoutId == null) return false;
  try {
    await client.connectapi(`/workout-service/workout/${workoutId}`);
    return false;
  } catch (err) {
    return (err as { status?: unknown })?.status === 404;
  }
}

/**
 * Put a re-created workout back on the dates its routine had booked.
 *
 * Garmin deletes a workout's calendar entries with the workout, so after the
 * delete-then-create in syncRoutine the routine is off the calendar while
 * routine_schedules still lists its dates. Today-or-later dates are booked again
 * on the new workout and their old rows replaced; past dates are dropped, since
 * re-booking them would put a stale planned workout into calendar history. A
 * date that fails to book keeps its old row, so the next sync can try again.
 * Ported from the Python sync, which did this (sync.py, the reschedule after
 * create_workout). Returns whether any date is still waiting.
 */
async function rebookSchedules(
  hevyId: string,
  garminWorkoutId: number | string,
  sql: Sql,
  client: GarminClient,
  today: string,
): Promise<boolean> {
  const rows = (await sql`
    SELECT schedule_id, scheduled_date FROM routine_schedules WHERE hevy_routine_id = ${hevyId}
  `.catch(() => [])) as Array<{ schedule_id: string; scheduled_date: string | null }>;
  const byDate = new Map<string, string[]>();
  for (const row of rows) {
    const date = row.scheduled_date ?? "";
    byDate.set(date, [...(byDate.get(date) ?? []), String(row.schedule_id)]);
  }
  let pending = false;
  for (const [date, oldIds] of byDate) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today) {
      const r = await scheduleRoutine(hevyId, garminWorkoutId, date, sql, { garminClientFactory: async () => client });
      if (r.status !== "scheduled") {
        pending = true;
        continue;
      }
    }
    for (const id of oldIds) {
      await sql`DELETE FROM routine_schedules WHERE hevy_routine_id = ${hevyId} AND schedule_id = ${id}`;
    }
  }
  return pending;
}

export interface RoutineSyncResult {
  /** `skipped` means the routine was already on Garmin and unchanged (#603). */
  status: "synced" | "skipped" | "error";
  garminWorkoutId: number | string | null;
  error: string | null;
}

/** Create a Garmin planned workout from a Hevy routine and record it. */
export async function syncRoutine(
  routine: HevyRoutine,
  sql: Sql = getDb(),
  opts: Opts = {},
): Promise<RoutineSyncResult> {
  try {
    const client = await (opts.garminClientFactory ?? (() => getGarminClient()))();
    const payload = routineToGarminWorkout(routine, opts);
    const hevyId = String(routine.id);
    const workoutName = String((payload as { workoutName?: unknown }).workoutName ?? "");
    const contentHash = workoutContentHash(payload);

    const rows = (await sql`
      SELECT garmin_workout_id, status, content_hash FROM synced_routines
      WHERE hevy_routine_id = ${hevyId} LIMIT 1
    `.catch(() => [])) as Array<{
      garmin_workout_id: string | null;
      status: string | null;
      content_hash: string | null;
    }>;
    const existing = rows[0] ?? null;

    // Nothing has changed, so there is nothing to do. Recreating an identical
    // workout spends rate-limited Garmin calls to end up where we already were,
    // and before the delete below existed it also left a second copy behind.
    //
    // The hash covers the GENERATED payload, so a change to the builder
    // re-syncs everything on its own rather than needing a manual force
    // (`sync.py:1036-1046`).
    //
    // `schedule_pending` is deliberately not skippable: that row is unfinished,
    // and skipping it would strand the schedule retry.
    let status = existing?.status ?? "success";
    if (!opts.force && existing?.content_hash === contentHash && status === "success") {
      // A workout deleted in Garmin Connect still has a "success" row, because nothing
      // told us. Skipping it would leave the routine impossible to sync again, so ask
      // Garmin for it first (#729).
      if (!(await workoutGoneOnGarmin(client, existing.garmin_workout_id))) {
        return { status: "skipped", garminWorkoutId: existing.garmin_workout_id, error: null };
      }
      status = "missing_on_garmin";
    }

    // Ask Garmin what it actually has, so orphans from earlier syncs, a crash,
    // or a database reset are cleaned up rather than accumulating. A listing
    // that fails is "unknown", not "empty": we fall back to the tracked id
    // alone rather than assuming the library is bare.
    let library: GarminLibraryWorkout[] = [];
    try {
      library = await listGarminWorkouts(client);
    } catch {
      library = [];
    }

    // Delete BEFORE creating. The other order means a crash in between leaves
    // the user with two workouts, which is the bug being fixed; this order
    // leaves them with none, and the next sync puts it back.
    for (const staleId of staleWorkoutIds(library, workoutName, existing?.garmin_workout_id ?? null, existing ? status : null)) {
      try {
        await deleteGarminWorkout(client, staleId);
      } catch {
        // A stale copy we could not remove is untidy; failing the sync over it
        // would leave the user with no current workout at all.
      }
    }

    const res = await client.post<{ workoutId?: number }>("/workout-service/workout", payload);
    const garminWorkoutId = res?.workoutId ?? null;
    await sql`
      INSERT INTO synced_routines (hevy_routine_id, garmin_workout_id, title, status, content_hash, synced_at)
      VALUES (
        ${hevyId},
        ${garminWorkoutId != null ? String(garminWorkoutId) : null},
        ${routine.title ?? routine.name ?? ""},
        'success', ${contentHash}, NOW()
      )
      ON CONFLICT (hevy_routine_id) DO UPDATE SET
        garmin_workout_id = EXCLUDED.garmin_workout_id,
        title = EXCLUDED.title,
        status = 'success',
        content_hash = EXCLUDED.content_hash,
        synced_at = NOW()
    `;
    if (existing && garminWorkoutId != null) {
      const today = opts.today ?? todayInZone((await loadSyncSettings(sql)).profile.timezone);
      if (await rebookSchedules(hevyId, garminWorkoutId, sql, client, today)) {
        // Not skippable, so the next sync re-creates the workout and tries the dates again.
        await sql`UPDATE synced_routines SET status = 'schedule_pending' WHERE hevy_routine_id = ${hevyId}`;
      }
    }
    return { status: "synced", garminWorkoutId, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", garminWorkoutId: null, error };
  }
}

/**
 * Flag synced routines whose Garmin planned workout no longer exists.
 *
 * `workouts` is a full listing; `null` means the listing FAILED. On null this
 * does nothing at all, because treating an error as "the user deleted
 * everything" would flip every routine on the dashboard to missing at once,
 * which is a far worse bug than the one it fixes (`reconcile.py:77-114`).
 *
 * An id that reappears flips back to success, which self-heals a false positive
 * from a truncated listing. `schedule_pending` rows are never promoted, because
 * that would cancel their schedule retry.
 *
 * Returns the routine ids whose status changed.
 */
export async function reconcileMissingRoutineWorkouts(
  sql: Sql,
  workouts: GarminLibraryWorkout[] | null,
): Promise<string[]> {
  if (workouts === null) return [];
  const present = new Set(workouts.map((w) => String(w.id)));
  const changed: string[] = [];
  try {
    const rows = (await sql`
      SELECT hevy_routine_id, garmin_workout_id, status FROM synced_routines
      WHERE garmin_workout_id IS NOT NULL
    `) as Array<{ hevy_routine_id: string; garmin_workout_id: string; status: string | null }>;

    for (const row of rows) {
      const status = row.status ?? "success";
      const isPresent = present.has(String(row.garmin_workout_id));
      if (!isPresent && status !== "missing_on_garmin") {
        await sql`
          UPDATE synced_routines SET status = 'missing_on_garmin'
          WHERE hevy_routine_id = ${row.hevy_routine_id}
        `;
        changed.push(row.hevy_routine_id);
      } else if (isPresent && status === "missing_on_garmin") {
        await sql`
          UPDATE synced_routines SET status = 'success'
          WHERE hevy_routine_id = ${row.hevy_routine_id}
        `;
        changed.push(row.hevy_routine_id);
      }
    }
  } catch {
    // Best effort, exactly as in Python. A reconcile that cannot run must not
    // fail the sync it is part of.
  }
  return changed;
}

export interface RoutineScheduleResult {
  status: "scheduled" | "error";
  scheduleId: string | null;
  error: string | null;
}

/** Schedule a synced routine's Garmin workout onto a date and record it. */
export async function scheduleRoutine(
  hevyRoutineId: string,
  garminWorkoutId: number | string,
  date: string,
  sql: Sql = getDb(),
  opts: { garminClientFactory?: () => Promise<GarminClient> } = {},
): Promise<RoutineScheduleResult> {
  try {
    const client = await (opts.garminClientFactory ?? (() => getGarminClient()))();
    const res = await client.post<{ workoutScheduleId?: number }>(
      `/workout-service/schedule/${garminWorkoutId}`,
      { date },
    );
    const scheduleId = res?.workoutScheduleId != null ? String(res.workoutScheduleId) : String(Date.now());
    await sql`
      INSERT INTO routine_schedules (hevy_routine_id, schedule_id, scheduled_date)
      VALUES (${hevyRoutineId}, ${scheduleId}, ${date})
      ON CONFLICT (hevy_routine_id, schedule_id) DO NOTHING
    `;
    return { status: "scheduled", scheduleId, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", scheduleId: null, error };
  }
}

export interface RoutineUnscheduleResult {
  status: "unscheduled" | "error";
  error: string | null;
}

/** Remove a Garmin calendar entry (workoutScheduleId) and its local record. */
export async function unscheduleRoutine(
  hevyRoutineId: string,
  scheduleId: string,
  sql: Sql = getDb(),
  opts: { garminClientFactory?: () => Promise<GarminClient> } = {},
): Promise<RoutineUnscheduleResult> {
  try {
    const client = await (opts.garminClientFactory ?? (() => getGarminClient()))();
    try {
      await garminDelete(client, `/workout-service/schedule/${scheduleId}`);
    } catch (err) {
      // 404: the entry is already gone, most often because the workout was deleted
      // in Garmin Connect and took its calendar entries with it. Removing it here is
      // then only the local record, which is what the user asked for (#729).
      if (!(err instanceof GarminDeleteError && err.status === 404)) throw err;
    }
    await sql`
      DELETE FROM routine_schedules
      WHERE hevy_routine_id = ${hevyRoutineId} AND schedule_id = ${scheduleId}
    `;
    return { status: "unscheduled", error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", error };
  }
}

export interface RoutineRemoveResult {
  status: "removed" | "error";
  error: string | null;
}

/**
 * Remove a synced routine: delete its planned workout on Garmin and its rows here
 * (#733). A 404 from Garmin means the workout is already gone, often deleted in
 * Garmin Connect, so the local rows are removed anyway. Garmin deletes a workout's
 * calendar entries with it, so the routine's schedule rows go too. Any other
 * failure keeps everything, so a removal never leaves Garmin with a workout the
 * page no longer lists.
 */
export async function removeRoutine(
  hevyRoutineId: string,
  sql: Sql = getDb(),
  opts: { garminClientFactory?: () => Promise<GarminClient> } = {},
): Promise<RoutineRemoveResult> {
  try {
    const rows = (await sql`
      SELECT garmin_workout_id FROM synced_routines WHERE hevy_routine_id = ${hevyRoutineId} LIMIT 1
    `) as Array<{ garmin_workout_id: string | null }>;
    const workoutId = rows[0]?.garmin_workout_id ?? null;
    if (workoutId != null) {
      const client = await (opts.garminClientFactory ?? (() => getGarminClient()))();
      try {
        await deleteGarminWorkout(client, workoutId);
      } catch (err) {
        if (!(err instanceof GarminDeleteError && err.status === 404)) throw err;
      }
    }
    await sql`DELETE FROM routine_schedules WHERE hevy_routine_id = ${hevyRoutineId}`;
    await sql`DELETE FROM synced_routines WHERE hevy_routine_id = ${hevyRoutineId}`;
    return { status: "removed", error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", error };
  }
}
