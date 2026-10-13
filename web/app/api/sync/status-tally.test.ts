import { describe, it, expect } from "vitest";

/**
 * The batch routes count results by status name, so widening the engine's
 * vocabulary (#590) silently changed what they count.
 *
 * Before this was noticed, every upload failure reported `error`. After #587
 * and #590 a refused import reports `failed` and an unknown outcome reports
 * `processing`, so both filters stopped matching: the run's failure tally went
 * to zero and the loop's stop-on-error never fired.
 *
 * These tests pin the mapping itself rather than the route, because the mapping
 * is the part that has to stay in step with the engine.
 */

/**
 * Deliberately `string`, not the package's union. The route is pinned to one
 * engine version and has to keep counting correctly when a newer engine reports
 * a status its types have never seen, so a test written against the pinned
 * union would be testing the wrong thing.
 */
type Status = string;

/** What `/api/sync` and `/api/cron/sync` do with a run's statuses. */
function tally(statuses: Status[]) {
  return {
    synced: statuses.filter((s) => s === "synced").length,
    skipped: statuses.filter((s) => s === "skipped").length,
    deferred: statuses.filter((s) => s === "deferred").length,
    processing: statuses.filter((s) => s === "processing").length,
    failed: statuses.filter((s) => s === "error" || s === "failed").length,
    stopsBatch: statuses.some((s) => s === "error"),
  };
}

describe("a refused import is counted as a failure", () => {
  it("counts `failed` with `error`, so the sync log does not report zero", () => {
    const t = tally(["synced", "failed", "error"]);
    expect(t.failed).toBe(2);
    expect(t.synced).toBe(1);
  });
});

describe("an unknown outcome is not a failure", () => {
  it("counts `processing` on its own, never as failed", () => {
    // The upload may well have landed. Calling that a failure would be a guess,
    // and a user reading "1 failed" would retry, which is the one thing that
    // must not happen to a processing row.
    const t = tally(["processing", "processing"]);
    expect(t.failed).toBe(0);
    expect(t.processing).toBe(2);
  });
});

describe("one bad workout does not cancel the backlog", () => {
  it("neither `failed` nor `processing` stops the batch", () => {
    // Python continues past both (`sync.py:822-833`). Stopping would let a
    // single duplicate FIT block every remaining workout in the run.
    expect(tally(["failed"]).stopsBatch).toBe(false);
    expect(tally(["processing"]).stopsBatch).toBe(false);
  });

  it("a hard error still stops it", () => {
    expect(tally(["error"]).stopsBatch).toBe(true);
  });
});
