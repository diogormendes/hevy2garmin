/**
 * Record what a sync run did, so the dashboard's Sync log can show it.
 *
 * `sync_log` is created by the web schema and read by the dashboard, and until
 * now nothing on the TypeScript path ever wrote a row. The panel therefore said
 * "No sync runs recorded yet" while syncs were plainly happening, which is how
 * u/konspir came to doubt his own setup in #565. A log that can never fill is
 * worse than no log: it reads as evidence that nothing ran.
 *
 * Ported from `record_sync_log` in `src/hevy2garmin/syncstate.py`, including the
 * property that matters most: it is best-effort and never throws. It runs from
 * inside failure handling as well as success, so a write that raised here would
 * replace a handled error with an unhandled one. Losing a diagnostic row is
 * always the smaller loss.
 */
import type { SyncStore } from "./store";

/** How a run was started. Free-form, but these are the ones the UI shows. */
export type SyncTrigger = "manual" | "auto" | "cron" | "batch" | "recovery";

export interface SyncRunResult {
  synced?: number;
  skipped?: number;
  failed?: number;
}

export interface SyncLogEntry {
  synced: number;
  skipped: number;
  failed: number;
  trigger: string;
}

/** Coerce a possibly-missing count into a non-negative integer. */
function count(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** The row a result becomes. Exported so a caller can log it without a store. */
export function toSyncLogEntry(result: SyncRunResult, trigger: string = "manual"): SyncLogEntry {
  return {
    synced: count(result.synced),
    skipped: count(result.skipped),
    failed: count(result.failed),
    trigger: trigger || "manual",
  };
}

/**
 * Write one row describing a completed run.
 *
 * Returns whether a row was written, so a caller that cares can tell the
 * difference between "logged" and "the store does not support it", without
 * either case being able to break the sync.
 */
export async function recordSyncRun(
  store: Pick<SyncStore, "recordSyncLog">,
  result: SyncRunResult,
  trigger: string = "manual",
): Promise<boolean> {
  if (typeof store.recordSyncLog !== "function") return false;
  try {
    await store.recordSyncLog(toSyncLogEntry(result, trigger));
    return true;
  } catch {
    // Diagnostic only. Never let it surface: this runs inside failure handling.
    return false;
  }
}
