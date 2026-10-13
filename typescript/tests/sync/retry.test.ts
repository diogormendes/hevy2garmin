import { describe, it, expect, vi, beforeEach } from "vitest";
import { retryPending } from "../../src/sync/recovery";
import { MemoryStore, mockGateway, WORKOUT } from "./helpers";
import type { PendingRecord } from "../../src/sync/types";

/**
 * Retry is the most dangerous button in the product. It uploads, and it is
 * pressed by a user looking at a workout that seems stuck.
 *
 * Two problems, ported from `cmd_retry_failed` in `cli.py:341-368`.
 *
 * It had no phase guard, so it would fire while an upload was still in flight.
 * A FIT that has reached Garmin but not yet appeared as an activity makes the
 * existing-activity lookup honestly answer "nothing there", and the retry then
 * sends a second copy.
 *
 * And it hand-rolled a minimal upload, `generateFit(workout, null)` with no
 * profile, no heart rate and no merge, where Python re-runs the whole sync. So
 * a retried workout came back quietly worse than every other one the user has.
 */

let store: MemoryStore;
let gw: ReturnType<typeof mockGateway>;

const pendingRow = (over: Partial<PendingRecord> = {}): PendingRecord =>
  ({
    hevy_id: "hevy-1",
    phase: "failed",
    next_step: null,
    upload_id: null,
    garmin_activity_id: null,
    watch_activity_id: null,
    pre_upload_ids: [],
    resolution_source: null,
    attempt_count: 1,
    delete_attempt_count: 0,
    last_error: null,
    payload: { workout: WORKOUT, title: "Push Day", calories: 321, avg_hr: 110 },
    ...over,
  }) as unknown as PendingRecord;

const deps = () => ({
  store,
  gateway: vi.fn(async () => gw),
  fetchWorkouts: async () => [WORKOUT],
});

beforeEach(() => {
  store = new MemoryStore();
  gw = mockGateway();
  store.pending.set("hevy-1", pendingRow());
});

describe("retry refuses anything that is not definitively failed (#613)", () => {
  it("refuses a row still in processing, and uploads nothing", async () => {
    // The dangerous case. `processing` means the FIT may already be at Garmin,
    // so the lookup can honestly find nothing while the activity is on its way.
    // Retrying there is how one workout becomes two.
    store.pending.set("hevy-1", pendingRow({ phase: "processing" }));

    const r = await retryPending(deps() as never, "hevy-1");

    expect(gw.upload).not.toHaveBeenCalled();
    expect(r.status).not.toBe("synced");
  });

  it("refuses a row that is mid-finalization", async () => {
    store.pending.set("hevy-1", pendingRow({ phase: "finalizing", garmin_activity_id: "500" }));

    const r = await retryPending(deps() as never, "hevy-1");
    expect(gw.upload).not.toHaveBeenCalled();
  });

  it("says what to do instead, rather than only refusing", async () => {
    // A button that refuses without naming the alternative is a wall. Python's
    // message points at reconcile, and so does this one.
    store.pending.set("hevy-1", pendingRow({ phase: "processing" }));

    const r = await retryPending(deps() as never, "hevy-1");
    expect(String(r.error)).toMatch(/reconcile/i);
  });

  it("allows a row Garmin definitively refused", async () => {
    store.pending.set("hevy-1", pendingRow({ phase: "failed" }));

    const r = await retryPending(deps() as never, "hevy-1");
    expect(gw.upload).toHaveBeenCalled();
  });
});

describe("a retried workout is a normally synced workout (#614)", () => {
  it("goes through the real sync, so heart rate is fetched rather than skipped", async () => {
    // The old path passed `null` for HR and no profile, so a retried activity
    // had no heart rate and calories computed from nothing.
    const hr = {
      loadBackup: vi.fn(async () => null),
      saveBackup: vi.fn(async () => {}),
      cachedHr: vi.fn(async () => null),
    };
    const d = { ...deps(), hr };

    await retryPending(d as never, "hevy-1", { hrFusion: true } as never);

    // Reaching the HR layer at all is the assertion: the old implementation
    // could not, because it never called it.
    expect(hr.cachedHr).toHaveBeenCalled();
  });

  it("honours the watch strategy instead of always uploading a standalone activity", async () => {
    gw.activitiesByDate.mockResolvedValue([
      {
        activityId: 900,
        manufacturer: "GARMIN",
        activityType: { typeKey: "strength_training" },
        startTimeGMT: "2026-08-01 10:00:00",
        duration: 3600,
      },
    ]);

    await retryPending(deps() as never, "hevy-1", {
      merge: { enabled: true, watchStrategy: "merge" },
    } as never);

    // Merge asks Garmin for the activity's sets. The old retry never did.
    expect(gw.exerciseSets).toHaveBeenCalled();
  });

  it("clears the old pending row so the retry is not blocked by its own claim", async () => {
    await retryPending(deps() as never, "hevy-1");
    expect(store.deletePending).toHaveBeenCalledWith("hevy-1");
  });

  it("still never double-uploads: an activity already on Garmin is matched", async () => {
    gw.findExistingActivity.mockResolvedValue(4242);

    const r = await retryPending(deps() as never, "hevy-1");
    expect(gw.upload).not.toHaveBeenCalled();
  });
});
