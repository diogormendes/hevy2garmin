/**
 * Turn one sync result into the row the Sync log shows (#646).
 *
 * Counted BY NAME, never by exclusion. The engine is a separately versioned
 * package, so this can run against a version reporting statuses this repo has
 * never heard of. `app/api/sync/route.ts` already learned that the hard way
 * when `failed` and `processing` were added and silently fell out of the
 * tally; the first version of this function repeated the mistake in reverse,
 * counting every unrecognised status as a success.
 *
 * An unknown status is therefore counted as "did not sync", which can understate
 * a success but can never invent one.
 */
export interface SyncTally {
  synced: number;
  skipped: number;
  failed: number;
}

/**
 * The tally for a completed sync, or null when there is nothing to record.
 *
 * `none` means there was no candidate, so no sync happened and the log should
 * stay quiet. Writing a row for it would fill the panel with runs that did
 * nothing every time the button is pressed. `dry_run` cannot reach a live path,
 * and is refused here as well rather than trusted not to.
 */
export function tallyForLog(status: unknown): SyncTally | null {
  const s = String(status ?? "");
  if (s === "none" || s === "dry_run") return null;
  if (s === "synced") return { synced: 1, skipped: 0, failed: 0 };
  if (s === "error" || s === "failed") return { synced: 0, skipped: 0, failed: 1 };
  // skipped, deferred, processing, needs_review, merge_pending and anything the
  // engine adds later. `app/api/sync/route.ts` counts processing with the
  // workouts that did not sync this time rather than as a failure, because the
  // upload may well have landed and calling it failed would be a guess.
  return { synced: 0, skipped: 1, failed: 0 };
}
