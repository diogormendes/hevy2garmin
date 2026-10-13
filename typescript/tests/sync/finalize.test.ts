import { describe, it, expect, vi } from "vitest";
import { finalizePending, reconcilePending } from "../../src/sync/recovery";
import type { GarminGateway } from "../../src/sync/gateway";
import type { PendingRecord } from "../../src/sync/types";

/**
 * Resuming remote finalization from a durable checkpoint, ported from
 * `finalize_pending` in `src/hevy2garmin/sync.py:116`.
 *
 * The step that matters is the delete. A replace uploads a named activity and
 * then removes the watch copy, so a run that dies between those two leaves the
 * user with two activities for one workout, permanently: reconcile will not
 * clean it up, and a later sync will not either because the workout is already
 * in the ledger. The only trace is a `watch_activity_id` on a pending row that
 * nothing reads.
 *
 * Both guards here exist to avoid making that worse rather than better.
 */

function gateway(over: Partial<GarminGateway> = {}): GarminGateway {
  return {
    findExistingActivity: vi.fn(async () => null),
    upload: vi.fn(async () => ({ uploadId: 1, activityId: 999 })),
    rename: vi.fn(async () => {}),
    describe: vi.fn(async () => {}),
    activitiesByDate: vi.fn(async () => []),
    exerciseSets: vi.fn(async () => ({ exerciseSets: [] })),
    putExerciseSets: vi.fn(async () => {}),
    deleteActivity: vi.fn(async () => {}),
    activityFit: vi.fn(async () => null),
    ...over,
  } as unknown as GarminGateway;
}

function pending(over: Partial<PendingRecord> = {}): PendingRecord {
  return {
    hevy_id: "w1",
    phase: "finalizing",
    next_step: "rename",
    upload_id: "42",
    garmin_activity_id: "500",
    watch_activity_id: null,
    pre_upload_ids: [],
    attempt_count: 1,
    delete_attempt_count: 0,
    resolution_source: null,
    last_error: null,
    payload: { title: "Push Day", description_enabled: false, workout: { id: "w1" } },
    ...over,
  } as unknown as PendingRecord;
}

function store() {
  const updates: Array<Record<string, unknown>> = [];
  let row: PendingRecord | null = null;
  return {
    updates,
    setRow: (r: PendingRecord | null) => {
      row = r;
    },
    getPending: vi.fn(async () => row),
    updatePending: vi.fn(async (_id: string, f: Record<string, unknown>) => {
      updates.push(f);
      if (row) row = { ...row, ...f } as PendingRecord;
    }),
    completePending: vi.fn(async () => {}),
    deletePending: vi.fn(async () => true),
    markSynced: vi.fn(async () => {}),
    isSynced: vi.fn(async () => false),
    loadSyncedIds: vi.fn(async () => new Set<string>()),
    loadPendingIds: vi.fn(async () => new Set<string>()),
    claimPending: vi.fn(async () => true),
  };
}

const deps = (g: GarminGateway, s: ReturnType<typeof store>) =>
  ({ store: s, gateway: async () => g, fetchWorkouts: async () => [] }) as never;

describe("the delete step actually runs (#588)", () => {
  it("removes the watch copy when finalization resumes at the delete step", async () => {
    // This is the whole point. Before, nothing in recovery ever deleted, so a
    // replace interrupted after the upload left both activities for ever.
    const g = gateway();
    const s = store();
    s.setRow(pending({ next_step: "delete", watch_activity_id: "777" }));

    const r = await finalizePending(deps(g, s), "w1");

    expect(g.deleteActivity).toHaveBeenCalledWith(777);
    expect(r.status).toBe("synced");
    expect(s.completePending).toHaveBeenCalled();
  });

  it("resumes from rename and walks through to commit", async () => {
    const g = gateway();
    const s = store();
    s.setRow(pending({ next_step: "rename", watch_activity_id: "777" }));

    await finalizePending(deps(g, s), "w1");

    expect(g.rename).toHaveBeenCalledWith(500, "Push Day");
    expect(g.deleteActivity).toHaveBeenCalledWith(777);
    // Checkpointed between steps, so a crash resumes rather than restarting.
    expect(s.updates.map((u) => u.next_step)).toContain("delete");
  });

  it("skips the delete when there is no watch copy", async () => {
    const g = gateway();
    const s = store();
    s.setRow(pending({ next_step: "rename", watch_activity_id: null }));

    await finalizePending(deps(g, s), "w1");
    expect(g.deleteActivity).not.toHaveBeenCalled();
  });
});

describe("the delete guards (#588)", () => {
  it("refuses to delete when the replacement IS the watch activity", async () => {
    // The most destructive case in the batch. Deleting here would destroy the
    // activity that was just created, leaving the workout on neither side.
    const g = gateway();
    const s = store();
    s.setRow(pending({ next_step: "delete", garmin_activity_id: "500", watch_activity_id: "500" }));

    const r = await finalizePending(deps(g, s), "w1");

    expect(g.deleteActivity).not.toHaveBeenCalled();
    expect(r.status).toBe("needs_review");
    expect(s.updates.at(-1)).toMatchObject({ phase: "needs_review" });
  });

  it("counts a failed delete and parks for review on the third attempt", async () => {
    const g = gateway({
      deleteActivity: vi.fn(async () => {
        throw new Error("Garmin said no");
      }),
    });
    const s = store();
    s.setRow(pending({ next_step: "delete", watch_activity_id: "777", delete_attempt_count: 2 }));

    const r = await finalizePending(deps(g, s), "w1");

    expect(r.status).toBe("needs_review");
    expect(s.updates.at(-1)).toMatchObject({ phase: "needs_review", delete_attempt_count: 3 });
  });

  it("keeps a failed delete retryable before the third attempt", async () => {
    const g = gateway({
      deleteActivity: vi.fn(async () => {
        throw new Error("transient");
      }),
    });
    const s = store();
    s.setRow(pending({ next_step: "delete", watch_activity_id: "777", delete_attempt_count: 0 }));

    const r = await finalizePending(deps(g, s), "w1");

    expect(r.status).toBe("processing");
    expect(s.updates.at(-1)).toMatchObject({ next_step: "delete", delete_attempt_count: 1 });
    expect(s.completePending).not.toHaveBeenCalled();
  });
});

describe("reconcile refuses to adopt the wrong activity (#589)", () => {
  it("never adopts an id that existed before the upload", async () => {
    // Without this, reconcile can complete the pending against an activity we
    // did not create and record it as ours, which reads as success.
    const g = gateway({
      activitiesByDate: vi.fn(async () => [
        { activityId: 111, manufacturer: "DEVELOPMENT", activityType: { typeKey: "strength_training" }, startTimeGMT: "2026-03-15 18:02:00" },
      ]),
    });
    const s = store();
    s.setRow(pending({ garmin_activity_id: null, pre_upload_ids: ["111"], payload: { title: "t", workout: { id: "w1", start_time: "2026-03-15T18:02:00+00:00" } } }));

    const r = await reconcilePending(deps(g, s), "w1");

    expect(r.status).not.toBe("reconciled_synced");
    expect(s.completePending).not.toHaveBeenCalled();
  });

  it("never adopts the watch copy", async () => {
    const g = gateway({
      activitiesByDate: vi.fn(async () => [
        { activityId: 777, manufacturer: "GARMIN", activityType: { typeKey: "strength_training" }, startTimeGMT: "2026-03-15 18:02:00" },
      ]),
    });
    const s = store();
    s.setRow(pending({ garmin_activity_id: null, watch_activity_id: "777", payload: { title: "t", workout: { id: "w1", start_time: "2026-03-15T18:02:00+00:00" } } }));

    const r = await reconcilePending(deps(g, s), "w1");
    expect(r.status).not.toBe("reconciled_synced");
  });

  it("adopts exactly one DEVELOPMENT strength activity at the right time", async () => {
    const g = gateway({
      activitiesByDate: vi.fn(async () => [
        { activityId: 222, manufacturer: "DEVELOPMENT", activityType: { typeKey: "strength_training" }, startTimeGMT: "2026-03-15 18:02:00" },
      ]),
    });
    const s = store();
    s.setRow(pending({ garmin_activity_id: null, payload: { title: "t", description_enabled: false, workout: { id: "w1", start_time: "2026-03-15T18:02:00+00:00" } } }));

    const r = await reconcilePending(deps(g, s), "w1");
    expect(r.garminActivityId).toBe(222);
  });

  it("parks for review when several candidates are unverified", async () => {
    // Two plausible activities is not a coin toss. Picking one could mark the
    // workout synced against a stranger's activity, so a person decides.
    const g = gateway({
      activitiesByDate: vi.fn(async () => [
        { activityId: 301, manufacturer: "GARMIN", activityType: { typeKey: "strength_training" }, startTimeGMT: "2026-03-15 18:02:00" },
        { activityId: 302, manufacturer: "GARMIN", activityType: { typeKey: "strength_training" }, startTimeGMT: "2026-03-15 18:03:00" },
      ]),
    });
    const s = store();
    s.setRow(pending({ garmin_activity_id: null, payload: { title: "t", workout: { id: "w1", start_time: "2026-03-15T18:02:00+00:00" } } }));

    const r = await reconcilePending(deps(g, s), "w1");
    expect(r.status).toBe("needs_review");
  });

  it("refuses snapshot adoption entirely when there is no upload checkpoint", async () => {
    // No upload id, no snapshot and no attempt means we have no evidence an
    // upload was ever made, so anything found nearby belongs to someone else.
    const g = gateway({
      activitiesByDate: vi.fn(async () => [
        { activityId: 400, manufacturer: "DEVELOPMENT", activityType: { typeKey: "strength_training" }, startTimeGMT: "2026-03-15 18:02:00" },
      ]),
    });
    const s = store();
    s.setRow(
      pending({
        garmin_activity_id: null,
        upload_id: null,
        pre_upload_ids: [],
        attempt_count: 0,
        phase: "claimed",
        payload: { title: "t", workout: { id: "w1", start_time: "2026-03-15T18:02:00+00:00" } },
      }),
    );

    const r = await reconcilePending(deps(g, s), "w1");
    expect(r.status).toBe("needs_review");
    expect(s.completePending).not.toHaveBeenCalled();
  });

  it("finalizes instead of searching when the activity id is already known", async () => {
    const g = gateway();
    const s = store();
    s.setRow(pending({ garmin_activity_id: "500", next_step: "rename" }));

    const r = await reconcilePending(deps(g, s), "w1");
    expect(g.rename).toHaveBeenCalledWith(500, "Push Day");
    expect(r.status).toBe("synced");
  });

  it("reports failed without searching when the row is already failed", async () => {
    const g = gateway();
    const s = store();
    s.setRow(pending({ garmin_activity_id: null, phase: "failed" }));

    const r = await reconcilePending(deps(g, s), "w1");
    expect(r.status).toBe("failed");
    expect(g.activitiesByDate).not.toHaveBeenCalled();
  });
});
