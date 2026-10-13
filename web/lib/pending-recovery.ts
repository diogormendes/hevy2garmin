/**
 * Route-facing recovery for a stuck pending upload. The logic (reconcile →
 * match, never double-upload; retry → reconcile first, then re-upload) lives in
 * the `hevy2garmin` package; this binds it to the app's store and Garmin client
 * and keeps the `(hevyId, opts, sql)` signature the routes call.
 */
import {
  reconcilePending as engineReconcilePending,
  retryPending as engineRetryPending,
  type RecoveryOptions,
} from "hevy2garmin";
import { getDb } from "./db";
import type { Sql } from "./pending-store";
import { buildSyncDeps } from "./sync-one";
import { loadSyncSettings } from "./sync-settings";

export type { RecoveryOptions, RecoveryResult } from "hevy2garmin";

export function reconcilePending(hevyId: string, _opts: RecoveryOptions = {}, sql: Sql = getDb()) {
  return engineReconcilePending(buildSyncDeps(sql), hevyId);
}

/**
 * A retry now re-runs the ordinary sync, so it has to be handed the same saved
 * settings every other sync route gets. Without them the retry would run on
 * engine defaults, which means merge off and no user profile, and a retried
 * workout would come back missing exactly what #614 was about.
 */
export async function retryPending(hevyId: string, opts: RecoveryOptions = {}, sql: Sql = getDb()) {
  const saved = await loadSyncSettings(sql);
  return engineRetryPending(buildSyncDeps(sql), hevyId, {
    merge: saved.merge,
    hrFusion: saved.hrFusion,
    descriptionEnabled: saved.descriptionEnabled,
    profile: saved.profile,
    ...opts, // an explicit option still wins
  } as RecoveryOptions);
}
