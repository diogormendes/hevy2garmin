/**
 * Where the sync engine's heart rate comes from and where its backup is kept.
 *
 * Two stores, for two different jobs:
 *
 *   `hr_cache`  the dashboard's per-workout heart rate. A cheap source that
 *               saves a Garmin call when the timeline has already been fetched.
 *
 *   `app_cache` under `hr_backup_<workout_id>`, the durable backup. This one is
 *               load-bearing: replacing a watch activity deletes it, and the
 *               watch's own heart rate is the most valuable thing on it. The
 *               engine refuses to replace anything it cannot back up here.
 *
 * The payload is the one `save_hr_backup` in `hr.py` writes, field for field,
 * so a backup taken by either implementation is readable by the other. That
 * matters because a user can run the Python pipeline and this app against one
 * database, and a backup only the writer understands is not a backup.
 */
import type { HrPoint } from "hevy2garmin";
import type { Sql } from "./pending-store";

const BACKUP_PREFIX = "hr_backup_";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse a timestamp the way the rest of the engine does. */
function toDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const iso = v.includes("T") ? v : v.replace(" ", "T");
  const withZone = /[Z+]|[-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

function samplesOf(raw: unknown): HrPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: HrPoint[] = [];
  for (const s of raw) {
    if (!isObj(s)) continue;
    const time = Number(s.time);
    const hr = Math.trunc(Number(s.hr));
    if (Number.isFinite(time) && hr > 0 && hr < 256) out.push({ time, hr });
  }
  return out;
}

export interface HrWorkout {
  id?: string;
  start_time?: string | null;
  end_time?: string | null;
}

/**
 * Read a durable backup, rebased onto the workout's current window.
 *
 * The rebase is not decoration. A Hevy workout can be edited after a backup was
 * taken, so its start moves, and samples recorded against the old start would
 * land at the wrong place in the FIT. Samples that fall outside the current
 * window after the shift are dropped. Ported from `load_hr_backup`.
 */
export async function loadHrBackup(sql: Sql, workout: HrWorkout): Promise<HrPoint[] | null> {
  const id = workout?.id;
  if (!id) return null;
  const rows = (await sql`
    SELECT value FROM app_cache WHERE key = ${BACKUP_PREFIX + id} LIMIT 1
  `.catch(() => [] as Array<{ value: unknown }>)) as Array<{ value: unknown }>;
  const backup = rows[0]?.value;
  if (!isObj(backup)) return null;

  const stored = samplesOf(backup.hr_samples);
  if (!stored.length) return null;

  const storedStart = toDate(backup.workout_start);
  const currentStart = toDate(workout.start_time);
  const currentEnd = toDate(workout.end_time);
  const shiftS =
    storedStart && currentStart ? (storedStart.getTime() - currentStart.getTime()) / 1000 : 0;
  const durationS =
    currentStart && currentEnd ? (currentEnd.getTime() - currentStart.getTime()) / 1000 : null;

  const out: HrPoint[] = [];
  for (const s of stored) {
    const time = s.time + shiftS;
    if (time < 0) continue;
    if (durationS !== null && time > durationS) continue;
    out.push({ time, hr: s.hr });
  }
  out.sort((a, b) => a.time - b.time);
  return out.length ? out : null;
}

/**
 * Save a durable backup, keeping whichever series has more samples.
 *
 * A later, coarser import must never overwrite a denser recording taken from
 * the watch's own FIT. Throws when the write fails, and that is deliberate:
 * the engine treats a failed save as a reason not to delete the watch
 * activity, so swallowing it here would let the HR be destroyed.
 */
export async function saveHrBackup(
  sql: Sql,
  workout: HrWorkout,
  samples: HrPoint[],
  sourceActivityId: number | string,
): Promise<void> {
  const id = workout?.id;
  if (!id || !samples?.length) return;
  const key = BACKUP_PREFIX + id;

  const rows = (await sql`SELECT value FROM app_cache WHERE key = ${key} LIMIT 1`.catch(
    () => [] as Array<{ value: unknown }>,
  )) as Array<{ value: unknown }>;
  const existing = rows[0]?.value;
  const existingCount = isObj(existing) ? Number(existing.sample_count) || 0 : 0;
  if (existingCount >= samples.length) return;

  const payload = {
    version: 1,
    source: "garmin_activity_fit",
    source_activity_id: String(sourceActivityId),
    workout_start: workout.start_time ?? "",
    workout_end: workout.end_time ?? "",
    sample_count: samples.length,
    hr_samples: samples.map((s) => ({ time: Number(s.time), hr: Math.trunc(s.hr) })),
    backed_up_at: new Date().toISOString(),
  };

  await sql`
    INSERT INTO app_cache (key, value)
    VALUES (${key}, ${sql.json(payload)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

/**
 * The dashboard's cached heart rate for a workout.
 *
 * Only `hr_samples` is usable here: the `samples` key the HR chart reads is a
 * bare list of readings with no timestamps, which cannot be placed in a FIT.
 */
export async function cachedHr(sql: Sql, hevyId: string): Promise<HrPoint[] | null> {
  if (!hevyId) return null;
  const rows = (await sql`
    SELECT data FROM hr_cache WHERE hevy_id = ${hevyId} LIMIT 1
  `.catch(() => [] as Array<{ data: unknown }>)) as Array<{ data: unknown }>;
  const data = rows[0]?.data;
  if (!isObj(data)) return null;
  const out = samplesOf(data.hr_samples);
  return out.length ? out : null;
}

/**
 * Populate `hr_cache` for a workout.
 *
 * Writes BOTH shapes, because the table has two readers that want different
 * things and neither is wrong. `hr_samples` is the `{time, hr}` series the sync
 * embeds in a FIT; `samples` is the bare list of readings the dashboard's chart
 * draws. The demo seed only ever wrote `samples`, which is why the chart worked
 * on the demo while `cachedHr` returned null even there (#612).
 */
export async function saveHrCache(sql: Sql, hevyId: string, samples: HrPoint[]): Promise<void> {
  if (!hevyId || !samples.length) return;
  const value = {
    hr_samples: samples,
    samples: samples.map((s) => s.hr),
    interval_s: null,
  };
  await sql`
    INSERT INTO hr_cache (hevy_id, data, cached_at)
    VALUES (${hevyId}, ${sql.json(value)}, NOW())
    ON CONFLICT (hevy_id) DO UPDATE SET data = EXCLUDED.data, cached_at = NOW()
  `;
}

/** The HR half of `SyncDeps`, bound to one connection and one workout list. */
export function hrDepsFor(sql: Sql, workoutsById: () => Map<string, HrWorkout>) {
  return {
    loadBackup: (hevyId: string) => loadHrBackup(sql, workoutsById().get(hevyId) ?? { id: hevyId }),
    saveBackup: async (hevyId: string, samples: HrPoint[]) => {
      const w = workoutsById().get(hevyId) ?? { id: hevyId };
      await saveHrBackup(sql, w, samples, w.id ?? hevyId);
    },
    cachedHr: (hevyId: string) => cachedHr(sql, hevyId),
    saveCache: (hevyId: string, samples: HrPoint[]) => saveHrCache(sql, hevyId, samples),
  };
}
