/**
 * Heart-rate fusion: give a synced workout the best HR series available.
 *
 * `hr_fusion` was offered in Settings and read by nothing on the web path, so
 * the toggle did nothing at all (#566). This is the port of `src/hevy2garmin/hr.py`.
 *
 * Why it exists: when a workout replaces a watch recording, the watch's
 * high-resolution HR is the most valuable thing on that activity, and deleting
 * the activity destroys it. So the HR is extracted and stored BEFORE anything
 * destructive happens, and a replacement that cannot secure it must not proceed.
 * That is what `HRBackupError` enforces.
 *
 * Sources, in the order they are preferred:
 *   1. the matched watch activity's own FIT, densest and activity-specific,
 *   2. a durable backup saved by an earlier run,
 *   3. the consumer's cached HR for this workout,
 *   4. Garmin's coarser daily monitoring feed.
 *
 * Hevy's own in-workout HR (AirPods via HealthKit) outranks all of them, but
 * the public Hevy API does not expose it today, so `extractHevyHr` returns an
 * empty list. It is kept as the seam so nothing else changes when that data
 * appears.
 */
import { Decoder, Stream } from "@garmin/fitsdk";
import { toUtcDate } from "./match";

/** A resolved HR point. Assignable to fit.ts's HrSample, so fusion output
 *  feeds the FIT encoder directly. */
export interface HrPoint {
  /** Seconds from the workout start. */
  time: number;
  hr: number;
}

/** Thrown when a destructive replace cannot secure the watch's HR first. */
export class HRBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HRBackupError";
  }
}

/**
 * In-workout HR carried on the Hevy workout itself.
 *
 * Returns [] today: the Hevy public API exposes only weight, reps, distance,
 * duration and rpe, and AirPods HR stays in the app. Accepts both the object
 * and tuple shapes so nothing here changes if Hevy starts sending it.
 */
export function extractHevyHr(workout: Record<string, unknown>): HrPoint[] {
  const raw = workout.heart_rate ?? workout.heartRate ?? workout.hr_samples;
  if (!Array.isArray(raw)) return [];
  const out: HrPoint[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as { time?: unknown; hr?: unknown };
      if (e.hr != null && e.time != null) {
        out.push({ time: Math.max(0, Number(e.time)), hr: Math.trunc(Number(e.hr)) });
      }
    } else if (Array.isArray(entry) && entry.length >= 2 && entry[1] != null) {
      out.push({ time: Math.max(0, Number(entry[0])), hr: Math.trunc(Number(entry[1])) });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Merge two HR series, preferring `primary` within each time bucket.
 *
 * Bucketing rather than concatenating is what makes the result usable: two
 * sources sampled at different rates would otherwise interleave into a jagged
 * series. Primary wins a bucket outright, secondary fills the gaps.
 */
export function mergeHrSources(
  primary: HrPoint[] | null | undefined,
  secondary: HrPoint[] | null | undefined,
  bucketS = 10,
): HrPoint[] {
  const p = primary ?? [];
  const s = secondary ?? [];
  if (!p.length) return [...s].sort((a, b) => a.time - b.time);
  if (!s.length) return [...p].sort((a, b) => a.time - b.time);

  const chosen = new Map<number, HrPoint>();
  for (const x of s) chosen.set(Math.floor(x.time / bucketS), x);
  for (const x of p) chosen.set(Math.floor(x.time / bucketS), x); // primary wins ties
  return [...chosen.keys()].sort((a, b) => a - b).map((k) => chosen.get(k)!);
}

/**
 * HR records out of a device FIT, as offsets from the workout start.
 *
 * Accepts the raw FIT or the zip Garmin's ORIGINAL download returns. Samples
 * outside the workout window are dropped: a watch left running past the session
 * would otherwise stretch the series well beyond the workout.
 */
export function extractHrFromFit(
  bytes: Uint8Array,
  workoutStart: Date,
  workoutEnd: Date,
): HrPoint[] {
  const fit = looksLikeZip(bytes) ? firstFileFromZip(bytes) : bytes;
  if (!fit) return [];

  let messages: Record<string, unknown[]>;
  try {
    const stream = Stream.fromByteArray(Array.from(fit));
    const decoder = new Decoder(stream);
    if (!decoder.isFIT() || !decoder.checkIntegrity()) return [];
    ({ messages } = decoder.read() as unknown as { messages: Record<string, unknown[]> });
  } catch {
    return []; // a corrupt download must not break a sync
  }

  const records = (messages.recordMesgs ?? []) as Array<{ timestamp?: unknown; heartRate?: unknown }>;
  const startMs = workoutStart.getTime();
  const endMs = workoutEnd.getTime();
  const out: HrPoint[] = [];
  for (const r of records) {
    if (r.heartRate == null || r.timestamp == null) continue;
    const ts = r.timestamp instanceof Date ? r.timestamp.getTime() : Date.parse(String(r.timestamp));
    if (Number.isNaN(ts) || ts < startMs || ts > endMs) continue;
    out.push({ time: (ts - startMs) / 1000, hr: Math.trunc(Number(r.heartRate)) });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Garmin's daily monitoring readings, sliced to the workout window.
 *
 * Port of the slicing in `fetch_watch_hr` (`hr.py`), including the one-minute
 * buffer either side: the feed is sampled every couple of minutes, so a strict
 * window would often drop the readings closest to the start and the end.
 */
export function dailyHrToPoints(
  values: Array<[number, number | null]> | null | undefined,
  workoutStart: Date,
  workoutEnd: Date,
): HrPoint[] {
  if (!Array.isArray(values)) return [];
  const startMs = workoutStart.getTime();
  const endMs = workoutEnd.getTime();
  const buffer = 60_000;
  const out: HrPoint[] = [];
  for (const entry of values) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [ts, bpm] = entry;
    if (bpm == null || typeof ts !== "number") continue;
    if (ts < startMs - buffer || ts > endMs + buffer) continue;
    out.push({ time: Math.max(0, (ts - startMs) / 1000), hr: Math.trunc(Number(bpm)) });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** A zip begins with the local file header signature "PK\x03\x04". */
export function looksLikeZip(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/**
 * The first entry of a zip, inflated if needed.
 *
 * Garmin's ORIGINAL download is a one-file zip holding the device FIT, so a
 * full zip reader would be more machinery than the job needs. Handles the two
 * methods Garmin uses: stored (0) and deflate (8).
 */
export function firstFileFromZip(zip: Uint8Array): Uint8Array | null {
  try {
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const method = dv.getUint16(8, true);
    const compressedSize = dv.getUint32(18, true);
    const nameLen = dv.getUint16(26, true);
    const extraLen = dv.getUint16(28, true);
    const start = 30 + nameLen + extraLen;
    const body = zip.subarray(start, compressedSize > 0 ? start + compressedSize : undefined);
    if (method === 0) return body;
    if (method === 8) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { inflateRawSync } = require("node:zlib");
      return new Uint8Array(inflateRawSync(Buffer.from(body)));
    }
    return null;
  } catch {
    return null;
  }
}

/** What `hrForSync` needs from its host. Each is best-effort unless noted. */
export interface HrDeps {
  /** The matched activity's own FIT bytes, or null. */
  fetchActivityFit?: (activityId: number | string) => Promise<Uint8Array | null>;
  /** A durable HR backup saved by an earlier run. */
  loadBackup?: (hevyId: string) => Promise<HrPoint[] | null>;
  /** Persist HR durably. Must throw if it cannot: a replace depends on it. */
  saveBackup?: (hevyId: string, samples: HrPoint[]) => Promise<void>;
  /** The consumer's cached HR for this workout. */
  cachedHr?: (hevyId: string) => Promise<HrPoint[] | null>;
  /**
   * Populate that cache. Optional, and best-effort: a failure here must never
   * cost the caller the heart rate it just found, because the cache is only an
   * optimisation and the FIT is the thing that matters.
   *
   * Without it nothing ever wrote the cache, so `cachedHr` always returned null
   * and the dashboard's per-workout chart was empty on every real install
   * (#612).
   */
  saveCache?: (hevyId: string, samples: HrPoint[]) => Promise<void>;
  /** Garmin's coarser daily monitoring HR across the workout window. */
  dailyHr?: (start: Date, end: Date) => Promise<HrPoint[] | null>;
}

export interface HrForSyncOptions {
  enabled?: boolean;
  /** Set when a watch activity is about to be replaced, so its HR is at risk. */
  sourceActivityId?: number | string | null;
}

/**
 * The merged HR series to embed in a sync's FIT, or null.
 *
 * Best-effort everywhere except one case: when `sourceActivityId` is set, the
 * caller is about to delete that activity, and if neither its FIT nor a durable
 * backup can supply the HR this throws `HRBackupError` rather than returning
 * null. Returning null there would let the caller delete the only copy.
 */
export async function hrForSync(
  workout: Record<string, unknown> & { id?: string },
  deps: HrDeps,
  options: HrForSyncOptions = {},
): Promise<HrPoint[] | null> {
  if (options.enabled === false) return null;

  const hevyHr = extractHevyHr(workout);
  const hevyId = String(workout.id ?? "");
  const start = toUtcDate(String(workout.start_time ?? workout.startTime ?? ""));
  const end = toUtcDate(String(workout.end_time ?? workout.endTime ?? ""));

  /**
   * Cache what we found, so the next run can skip the Garmin call and the
   * dashboard has something to draw.
   *
   * Deliberately NOT called for HR that came from the cache. Rewriting it would
   * refresh `cached_at` on every sync, and that column is handed to the user as
   * "when this heart rate was fetched", so it would quietly start lying.
   */
  const cache = async (samples: HrPoint[]): Promise<void> => {
    if (!deps.saveCache || !hevyId || !samples.length) return;
    try {
      await deps.saveCache(hevyId, samples);
    } catch {
      // An optimisation must not cost the caller the HR it is about to embed.
    }
  };

  try {
    // 1. The watch recording itself, and save it before anything destructive.
    if (options.sourceActivityId != null && deps.fetchActivityFit && start && end) {
      let activityHr: HrPoint[] = [];
      try {
        const fit = await deps.fetchActivityFit(options.sourceActivityId);
        if (fit) activityHr = extractHrFromFit(fit, start, end);
      } catch {
        activityHr = [];
      }
      if (activityHr.length) {
        if (deps.saveBackup && hevyId) await deps.saveBackup(hevyId, activityHr);
        await cache(activityHr);
        return mergeHrSources(hevyHr, activityHr) || null;
      }
    }

    // 2. A durable backup from an earlier run.
    if (deps.loadBackup && hevyId) {
      const backup = await deps.loadBackup(hevyId);
      if (backup && backup.length) {
        await cache(backup);
        return mergeHrSources(hevyHr, backup) || null;
      }
    }

    // Nothing secured the watch's HR, and the caller is about to delete it.
    if (options.sourceActivityId != null) {
      throw new HRBackupError(
        `Garmin activity ${options.sourceActivityId} HR could not be extracted and no durable backup exists; source activity preserved`,
      );
    }

    // 3. The consumer's cache.
    if (deps.cachedHr && hevyId) {
      const cached = await deps.cachedHr(hevyId);
      if (cached && cached.length) return mergeHrSources(hevyHr, cached) || null;
    }

    // 4. Garmin's daily monitoring feed.
    if (deps.dailyHr && start && end) {
      const daily = await deps.dailyHr(start, end);
      if (daily && daily.length) {
        await cache(daily);
        return mergeHrSources(hevyHr, daily) || null;
      }
    }

    return hevyHr.length ? hevyHr : null;
  } catch (e) {
    if (e instanceof HRBackupError) throw e;
    return null; // HR must never break a sync
  }
}
