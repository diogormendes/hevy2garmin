/**
 * The storage boundary of the sync engine. The engine never touches a database
 * directly; it reads and writes its ledger (`synced_workouts` for terminal
 * state, `pending_uploads` for in-flight durable checkpoints) through this
 * interface. A consumer supplies an implementation — the web dashboard's is
 * Postgres; a test's is a Map. Every method is local bookkeeping: NOTHING here
 * calls Garmin, uploads a FIT, or mutates Hevy.
 */
import type { MarkSyncedOpts, PendingRecord, PendingUpdate } from "./types";

export interface SyncStore {
  /** True when the workout already has a terminal row (dedup layer 1). */
  isSynced(hevyId: string): Promise<boolean>;
  /** Every hevy_id with a terminal row. Batch read for dedup. */
  loadSyncedIds(): Promise<Set<string>>;
  /** Every hevy_id with an in-flight pending row. Batch read for dedup. */
  loadPendingIds(): Promise<Set<string>>;
  /** One pending row by id, or null. */
  getPending(hevyId: string): Promise<PendingRecord | null>;
  /**
   * Atomically claim a workout (INSERT ... ON CONFLICT DO NOTHING). Returns true
   * when THIS caller won the claim, false when a row already existed (dedup
   * layer 3). Claiming is bookkeeping only — it does NOT begin an upload.
   */
  claimPending(hevyId: string, payload: Record<string, unknown>): Promise<boolean>;
  /** Update a pending row's checkpoint fields. Never fires an upload. */
  updatePending(hevyId: string, fields: PendingUpdate): Promise<void>;
  /** Delete a pending row. Returns whether a row was removed. */
  deletePending(hevyId: string): Promise<boolean>;
  /** Write the terminal success row AND clear the pending row. */
  completePending(hevyId: string, opts: MarkSyncedOpts): Promise<void>;
  /** Record a workout as terminally synced (status='success'). Local ledger only. */
  markSynced(hevyId: string, opts: MarkSyncedOpts): Promise<void>;
  /**
   * Append one row to the run log the dashboard's Sync log panel reads.
   *
   * Optional so an existing consumer keeps compiling, but a consumer that
   * omits it leaves that panel permanently empty, which reads to a user as
   * proof that nothing ever ran (#565, #569).
   */
  recordSyncLog?(entry: import("./run-log").SyncLogEntry): Promise<void>;

  /**
   * Durable state for merge, defined in `./merge` and kept deliberately narrow
   * rather than as a general key-value door onto the app's storage.
   *
   * Optional for the same reason as above, and with the same caveat: a
   * consumer that omits these keeps working, but its merge backup only lives
   * as long as the request and its circuit breaker never trips (#585, #598).
   */
  loadMergeBackup?(activityId: number): Promise<Record<string, unknown> | null>;
  saveMergeBackup?(activityId: number, sets: Record<string, unknown>): Promise<void>;
  clearMergeBackup?(activityId: number): Promise<void>;
  loadMergeFailures?(): Promise<number>;
  saveMergeFailures?(count: number): Promise<void>;
}
