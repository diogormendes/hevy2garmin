import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncOneWorkout, listCandidates } from "../../src/sync";
import { GarminUploadRejected } from "../../src/garmin";
import { MemoryStore, mockGateway, WORKOUT } from "./helpers";

/**
 * The central safety property: in dryRun (the DEFAULT) NO Garmin write and NO
 * store mutation are reachable. The gateway and the store are spies; we assert
 * they are NEVER called on the dry-run path. FIT generation is real (pure).
 */
let store: MemoryStore;
let gw: ReturnType<typeof mockGateway>;
let gatewayFactory: ReturnType<typeof vi.fn<() => Promise<typeof gw>>>;

const deps = () => ({ store, gateway: gatewayFactory, fetchWorkouts: async () => [WORKOUT] });

function expectNoWrites() {
  expect(gw.upload).not.toHaveBeenCalled();
  expect(gw.rename).not.toHaveBeenCalled();
  expect(gw.describe).not.toHaveBeenCalled();
  expect(store.claimPending).not.toHaveBeenCalled();
  expect(store.completePending).not.toHaveBeenCalled();
  expect(store.markSynced).not.toHaveBeenCalled();
  expect(store.updatePending).not.toHaveBeenCalled();
  expect(store.deletePending).not.toHaveBeenCalled();
}

beforeEach(() => {
  store = new MemoryStore();
  gw = mockGateway();
  gatewayFactory = vi.fn(async () => gw);
});

describe("syncOneWorkout — dry-run is the DEFAULT and never writes", () => {
  it("defaults to dryRun when no option is passed (fresh → wouldUpload, no writes)", async () => {
    const res = await syncOneWorkout(deps());
    expect(res.dryRun).toBe(true);
    expect(res.status).toBe("dry_run");
    expect(res.wouldUpload).toBe(true);
    expect(res.dedupDecision).toBe("would_upload");
    expect(res.workout?.hevy_id).toBe("hevy-1");
    expect(res.fitStats?.exercises).toBe(1);
    expect(res.fitStats?.totalSets).toBe(1);
    // The layer-2 read IS allowed (it's a read), but NO write happens.
    expect(gw.findExistingActivity).toHaveBeenCalledTimes(1);
    expectNoWrites();
  });

  it("explicit dryRun:true also performs zero writes", async () => {
    const res = await syncOneWorkout(deps(), { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.wouldUpload).toBe(true);
    expectNoWrites();
  });
});

describe("dedup layer 1 — already-synced is skipped, never uploaded", () => {
  it("id-set marks it synced → filtered out → no_candidates", async () => {
    store.syncedIds.add("hevy-1");
    const res = await syncOneWorkout(deps());
    expect(res.status).toBe("none");
    expect(res.dedupDecision).toBe("no_candidates");
    expect(res.wouldUpload).toBe(false);
    expect(gatewayFactory).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("live re-check: isSynced true for the picked id → skipped, no upload", async () => {
    store.isSyncedOverride = true; // passes the snapshot, fails the live ledger check
    const res = await syncOneWorkout(deps(), { dryRun: false });
    expect(res.status).toBe("skipped");
    expect(res.dedupDecision).toBe("already_synced");
    expectNoWrites();
  });
});

describe("dedup layer 2 — existing Garmin activity → match, NOT upload", () => {
  it("dry-run: reports the match, no writes", async () => {
    gw.findExistingActivity.mockResolvedValue(4242);
    const res = await syncOneWorkout(deps());
    expect(res.dryRun).toBe(true);
    expect(res.dedupDecision).toBe("existing_garmin_activity");
    expect(res.wouldUpload).toBe(false);
    expect(res.existingGarminActivityId).toBe(4242);
    expect(res.syncMethod).toBe("match");
    expectNoWrites();
  });

  it("live: matches + renames the existing activity, NEVER uploads a FIT", async () => {
    gw.findExistingActivity.mockResolvedValue(4242);
    const res = await syncOneWorkout(deps(), { dryRun: false });
    expect(res.status).toBe("synced");
    expect(res.dedupDecision).toBe("existing_garmin_activity");
    expect(res.garminActivityId).toBe(4242);
    expect(gw.upload).not.toHaveBeenCalled();
    expect(gw.rename).toHaveBeenCalledWith(4242, "Push Day");
    expect(gw.describe).toHaveBeenCalledTimes(1);
    expect(store.markSynced).toHaveBeenCalledTimes(1);
    expect(store.claimPending).not.toHaveBeenCalled();
  });
});

describe("dedup layer 3 + live upload — fresh workout on the live path", () => {
  it("claims, uploads, finalizes, and completes the pending row", async () => {
    const res = await syncOneWorkout(deps(), { dryRun: false });
    expect(res.status).toBe("synced");
    expect(res.dedupDecision).toBe("would_upload");
    expect(res.garminActivityId).toBe(555);
    expect(store.claimPending).toHaveBeenCalledTimes(1);
    expect(gw.upload).toHaveBeenCalledTimes(1);
    expect(gw.rename).toHaveBeenCalledWith(555, "Push Day");
    expect(gw.describe).toHaveBeenCalledTimes(1);
    expect(store.completePending).toHaveBeenCalledTimes(1);
  });

  it("claim lost (another worker holds it) → deferred, NO upload", async () => {
    store.claimResult = false;
    const res = await syncOneWorkout(deps(), { dryRun: false });
    expect(res.status).toBe("deferred");
    expect(res.dedupDecision).toBe("claim_lost");
    expect(gw.upload).not.toHaveBeenCalled();
    expect(store.completePending).not.toHaveBeenCalled();
    expect(store.markSynced).not.toHaveBeenCalled();
  });

  it("upload throws → parks pending as processing with the error, no completion", async () => {
    gw.upload.mockRejectedValue(new Error("Garmin upload failed (500)"));
    const res = await syncOneWorkout(deps(), { dryRun: false });
    // Reported as `processing`, not `error`. The row was already parked in the
    // processing phase; what changed is that the caller is now told so. An
    // ordinary upload failure may still have reached Garmin, and calling it an
    // error invites the one thing that must not happen, a second upload.
    expect(res.status).toBe("processing");
    expect(res.error).toContain("Garmin upload failed");
    expect(store.claimPending).toHaveBeenCalledTimes(1);
    expect(store.updatePending).toHaveBeenCalledWith("hevy-1", expect.objectContaining({ phase: "processing" }));
    expect(store.completePending).not.toHaveBeenCalled();
  });

  it("a rejected upload parks as failed, because nothing is there to find", async () => {
    gw.upload.mockRejectedValue(new GarminUploadRejected("Garmin rejected upload: [duplicate]"));
    const res = await syncOneWorkout(deps(), { dryRun: false });
    expect(res.status).toBe("failed");
    expect(store.updatePending).toHaveBeenCalledWith("hevy-1", expect.objectContaining({ phase: "failed" }));
    expect(store.completePending).not.toHaveBeenCalled();
  });

  it("refuses to adopt an activity id that already existed before the upload", async () => {
    // Garmin can answer with a pre-existing activity. Adopting it would mark
    // the workout synced against something we never created, and the real
    // upload would be lost.
    gw.activitiesByDate.mockResolvedValue([{ activityId: 555 }]);
    const res = await syncOneWorkout(deps(), { dryRun: false });
    expect(res.garminActivityId).toBeNull();
    expect(store.completePending).not.toHaveBeenCalled();
  });

  it("records the upload id so a reconcile can ask about this exact import", async () => {
    await syncOneWorkout(deps(), { dryRun: false });
    expect(store.updatePending).toHaveBeenCalledWith("hevy-1", expect.objectContaining({ upload_id: "99" }));
  });

  it("writes the pre-upload snapshot the reconcile needs", async () => {
    gw.activitiesByDate.mockResolvedValue([{ activityId: 11 }, { activityId: 12 }]);
    await syncOneWorkout(deps(), { dryRun: false });
    expect(store.updatePending).toHaveBeenCalledWith(
      "hevy-1",
      expect.objectContaining({ pre_upload_ids: ["11", "12"] }),
    );
  });

  it("drops the claim and rethrows when the snapshot itself fails", async () => {
    // Without a snapshot there is no safe way to tell our upload from something
    // that was already there, so Python refuses to upload blind and so do we.
    gw.activitiesByDate.mockRejectedValue(new Error("Garmin list failed"));
    await expect(syncOneWorkout(deps(), { dryRun: false })).rejects.toThrow("Garmin list failed");
    expect(gw.upload).not.toHaveBeenCalled();
    expect(store.deletePending).toHaveBeenCalledWith("hevy-1");
  });
});

describe("empty + edge inputs", () => {
  it("no workouts at all → none / no_candidates, no writes", async () => {
    const res = await syncOneWorkout({ ...deps(), fetchWorkouts: async () => [] });
    expect(res.status).toBe("none");
    expect(res.dedupDecision).toBe("no_candidates");
    expect(gatewayFactory).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("workout without a start_time → refuses to upload (dry_run), no writes", async () => {
    const res = await syncOneWorkout(
      { ...deps(), fetchWorkouts: async () => [{ ...WORKOUT, start_time: null }] },
      { dryRun: true },
    );
    expect(res.dedupDecision).toBe("no_start_time");
    expect(res.wouldUpload).toBe(false);
    expect(gatewayFactory).not.toHaveBeenCalled(); // never consulted Garmin
    expectNoWrites();
  });
});

describe("targetHevyId — sync a specific workout", () => {
  it("targets the matching candidate (dry-run), not the first", async () => {
    const res = await syncOneWorkout(deps(), { targetHevyId: "hevy-1" });
    expect(res.dryRun).toBe(true);
    expect(res.workout?.hevy_id).toBe("hevy-1");
    expect(res.dedupDecision).toBe("would_upload");
    expectNoWrites();
  });

  it("a target that is not a candidate → no_candidates", async () => {
    const res = await syncOneWorkout(deps(), { targetHevyId: "does-not-exist" });
    expect(res.status).toBe("none");
    expect(res.dedupDecision).toBe("no_candidates");
    expectNoWrites();
  });
});

describe("listCandidates — the unsynced list", () => {
  it("returns the unsynced workouts (dedup layer 1)", async () => {
    const cands = await listCandidates(deps());
    expect(cands).toHaveLength(1);
    expect(cands[0].hevy_id).toBe("hevy-1");
    expect(cands[0].title).toBe("Push Day");
    expectNoWrites();
  });

  it("excludes already-synced ids", async () => {
    store.syncedIds.add("hevy-1");
    expect(await listCandidates(deps())).toHaveLength(0);
  });
});
