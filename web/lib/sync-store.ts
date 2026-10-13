/**
 * The Postgres implementation of the engine's `SyncStore` boundary.
 *
 * The sync engine (`hevy2garmin` package) never touches a database; it reads
 * and writes its ledger through `SyncStore`. This adapter binds that interface
 * to the raw SQL helpers in `./pending-store` for one `sql` connection, so a
 * route builds a store from its `getDb()` tag and hands it to the engine.
 * Everything here is local bookkeeping: NOTHING calls Garmin or Hevy.
 */
import type { MarkSyncedOpts, PendingUpdate, SyncLogEntry, SyncStore } from "hevy2garmin";
import {
  claimPending,
  completePending,
  deletePending,
  getPending,
  isSynced,
  loadPendingIds,
  loadSyncedIds,
  markSynced,
  updatePending,
  type Sql,
} from "./pending-store";

/**
 * What this store provides, which is `SyncStore` plus the merge methods.
 *
 * Declared locally because the engine ships as its own npm package on its own
 * release cycle, and the pinned version's `SyncStore` does not know about
 * these yet. They are already implemented here so that publishing the engine
 * is all that is needed to turn them on, rather than a publish plus a second
 * change nobody remembers to make.
 */
type MergeCapableSyncStore = SyncStore & {
  loadMergeBackup(activityId: number): Promise<Record<string, unknown> | null>;
  saveMergeBackup(activityId: number, sets: Record<string, unknown>): Promise<void>;
  clearMergeBackup(activityId: number): Promise<void>;
  loadMergeFailures(): Promise<number>;
  saveMergeFailures(count: number): Promise<void>;
};

export function postgresSyncStore(sql: Sql): MergeCapableSyncStore {
  return {
    isSynced: (hevyId) => isSynced(hevyId, sql),
    loadSyncedIds: () => loadSyncedIds(sql),
    loadPendingIds: () => loadPendingIds(sql),
    getPending: (hevyId) => getPending(hevyId, sql),
    claimPending: (hevyId, payload) => claimPending(hevyId, payload, sql),
    updatePending: (hevyId, fields: PendingUpdate) => updatePending(hevyId, fields, sql),
    deletePending: (hevyId) => deletePending(hevyId, sql),
    completePending: (hevyId, opts: MarkSyncedOpts) => completePending(hevyId, opts, sql),
    markSynced: (hevyId, opts: MarkSyncedOpts) => markSynced(hevyId, opts, sql),
    recordSyncLog: (entry: SyncLogEntry) => recordSyncLog(entry, sql),
    loadMergeBackup: (activityId) => loadMergeBackup(activityId, sql),
    saveMergeBackup: (activityId, sets) => saveMergeBackup(activityId, sets, sql),
    clearMergeBackup: (activityId) => clearMergeBackup(activityId, sql),
    loadMergeFailures: () => loadMergeFailures(sql),
    saveMergeFailures: (count) => saveMergeFailures(count, sql),
  };
}

/**
 * The pre-merge backup of an activity's exercise sets.
 *
 * `merge_backup_<id>` is the same `app_cache` key Python writes at
 * `merge.py:495-503`, so a backup taken by either stack is readable by the
 * other. It has to be durable because an `exerciseSets` PUT replaces every set
 * on the activity, and the case worth protecting against is the process dying
 * between the PUT landing and the restore, which on a serverless request is an
 * ordinary timeout rather than a crash (#598).
 */
const backupKey = (activityId: number) => `merge_backup_${activityId}`;

async function loadMergeBackup(activityId: number, sql: Sql): Promise<Record<string, unknown> | null> {
  const rows = (await sql`
    SELECT value FROM app_cache WHERE key = ${backupKey(activityId)} LIMIT 1
  `.catch(() => [] as Array<{ value: unknown }>)) as Array<{ value: unknown }>;
  const v = rows[0]?.value;
  if (!v || typeof v !== "object") return null;
  const sets = (v as { original_sets?: unknown }).original_sets;
  return sets && typeof sets === "object" ? (sets as Record<string, unknown>) : null;
}

async function saveMergeBackup(
  activityId: number,
  sets: Record<string, unknown>,
  sql: Sql,
): Promise<void> {
  await sql`
    INSERT INTO app_cache (key, value, updated_at)
    VALUES (${backupKey(activityId)}, ${sql.json({ activity_id: activityId, original_sets: sets })}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

async function clearMergeBackup(activityId: number, sql: Sql): Promise<void> {
  await sql`DELETE FROM app_cache WHERE key = ${backupKey(activityId)}`;
}

/**
 * Consecutive `exerciseSets` PUT failures, for the merge circuit breaker.
 *
 * Kept in the database rather than in a module variable on purpose. Python's
 * counter is module state, which works because its dashboard is one long-lived
 * process; on a serverless request each sync can be a fresh process, so a
 * transliterated counter would reset constantly and never trip. That is the
 * same mistake the sync lock made in #570 (#585).
 */
const MERGE_FAILURES_KEY = "merge_consecutive_failures";

async function loadMergeFailures(sql: Sql): Promise<number> {
  const rows = (await sql`
    SELECT value FROM app_cache WHERE key = ${MERGE_FAILURES_KEY} LIMIT 1
  `.catch(() => [] as Array<{ value: unknown }>)) as Array<{ value: unknown }>;
  const v = rows[0]?.value;
  const n = v && typeof v === "object" ? Number((v as { count?: unknown }).count) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function saveMergeFailures(count: number, sql: Sql): Promise<void> {
  await sql`
    INSERT INTO app_cache (key, value, updated_at)
    VALUES (${MERGE_FAILURES_KEY}, ${sql.json({ count })}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

/**
 * Append one row to `sync_log`, the table the dashboard's Sync log panel reads.
 *
 * Nothing on this path ever wrote to it, so the panel said "No sync runs
 * recorded yet" while syncs were plainly happening, and a user read that as
 * proof his setup was broken (#565). Mirrors `record_sync_log` in
 * `syncstate.py`, including the column defaults.
 */
async function recordSyncLog(entry: SyncLogEntry, sql: Sql): Promise<void> {
  await sql`
    INSERT INTO sync_log (synced, skipped, failed, trigger)
    VALUES (${entry.synced}, ${entry.skipped}, ${entry.failed}, ${entry.trigger})
  `;
}
