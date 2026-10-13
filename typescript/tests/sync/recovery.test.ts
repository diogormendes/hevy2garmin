import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcilePending, retryPending, type PendingRecord } from "../../src/sync";
import { MemoryStore, mockGateway } from "./helpers";

/**
 * The "never double-upload" property: reconcile completes as matched; a retry
 * that finds an existing activity does NOT upload. Plus the happy retry path.
 */
let store: MemoryStore;
let gw: ReturnType<typeof mockGateway>;
let gatewayFactory: ReturnType<typeof vi.fn<() => Promise<typeof gw>>>;
const deps = () => ({ store, gateway: gatewayFactory });

const PENDING: PendingRecord = {
  hevy_id: "w1", phase: "processing", next_step: null, upload_id: null, garmin_activity_id: null,
  watch_activity_id: null, pre_upload_ids: [], resolution_source: null, attempt_count: 1,
  delete_attempt_count: 0, last_error: null, locked_until: null, created_at: null, updated_at: null,
  payload: {
    workout: { id: "w1", title: "Push Day", start_time: "2026-08-01T10:00:00Z", end_time: "2026-08-01T11:00:00Z",
               exercises: [{ title: "Bench Press", sets: [{ type: "normal", weight_kg: 80, reps: 5 }] }] },
    title: "Push Day", calories: 321, avg_hr: 110,
  },
};

beforeEach(() => {
  store = new MemoryStore();
  gw = mockGateway();
  gatewayFactory = vi.fn(async () => gw);
  store.pending.set("w1", PENDING);
});

describe("reconcilePending", () => {
  it("no pending row → not_found", async () => {
    store.pending.clear();
    const r = await reconcilePending(deps(), "w1");
    expect(r.status).toBe("not_found");
    expect(gw.findExistingActivity).not.toHaveBeenCalled();
  });

  it("no usable payload → no_payload, no Garmin call", async () => {
    store.pending.set("w1", { ...PENDING, payload: {} });
    const r = await reconcilePending(deps(), "w1");
    expect(r.status).toBe("no_payload");
    expect(gatewayFactory).not.toHaveBeenCalled();
  });

  it("Garmin already has it → adopts it and finalizes, no upload", async () => {
    // Reconcile no longer takes the first activity at the right start time.
    // Adopting means recording an activity as the one we created, so it now
    // requires an activity we actually made: DEVELOPMENT, strength-shaped, at
    // the workout's start. Python's reconcile never used a plain start-time
    // lookup either (`sync.py:254-261`); the loose version could complete a
    // pending against the user's own watch recording.
    gw.activitiesByDate.mockResolvedValue([
      {
        activityId: 4242,
        manufacturer: "DEVELOPMENT",
        activityType: { typeKey: "strength_training" },
        startTimeGMT: "2026-08-01 10:00:00",
      },
    ]);
    const r = await reconcilePending(deps(), "w1");
    expect(r.garminActivityId).toBe(4242);
    expect(store.completePending).toHaveBeenCalledWith(
      "w1", expect.objectContaining({ garminActivityId: "4242" }),
    );
    expect(gw.upload).not.toHaveBeenCalled();
  });

  it("Garmin has nothing → no_activity, pending left in place", async () => {
    const r = await reconcilePending(deps(), "w1");
    expect(r.status).toBe("no_activity");
    expect(store.completePending).not.toHaveBeenCalled();
    expect(store.updatePending).toHaveBeenCalledTimes(1);
  });
});

describe("retryPending", () => {
  // Retry now acts only on a row Garmin definitively refused. The shared
  // fixture is in `processing`, which is the phase a retry must NOT touch,
  // because the FIT may still be in flight (#613). These cases are about what
  // a retry does once it is allowed to run, so they set the phase that allows
  // it; the refusal itself is covered in retry.test.ts.
  beforeEach(() => {
    store.pending.set("w1", { ...PENDING, phase: "failed" });
  });

  it("Garmin already has it → matched, NEVER uploads", async () => {
    gw.findExistingActivity.mockResolvedValue(4242);
    const r = await retryPending(deps(), "w1");
    expect(r.status).toBe("reconciled_synced");
    expect(gw.upload).not.toHaveBeenCalled();
  });

  it("fresh → regenerates FIT, uploads, finalizes, completes", async () => {
    const r = await retryPending(deps(), "w1");
    expect(r.status).toBe("synced");
    expect(r.garminActivityId).toBe(555);
    expect(gw.upload).toHaveBeenCalledTimes(1);
    expect(gw.rename).toHaveBeenCalledWith(555, "Push Day");
    expect(gw.describe).toHaveBeenCalledTimes(1);
    expect(store.completePending).toHaveBeenCalledWith(
      "w1", expect.objectContaining({ garminActivityId: "555", syncMethod: "upload" }),
    );
  });

  it("upload throws → parks pending with the error, no completion", async () => {
    gw.upload.mockRejectedValue(new Error("Garmin upload failed (500)"));
    const r = await retryPending(deps(), "w1");
    // `processing`, not `error`. A retry that fails to upload is in exactly the
    // same unknown state as any other failed upload, and it now goes through
    // the same code path, so it reports the same thing. That is the point of
    // routing the retry through the real sync rather than its own copy.
    expect(r.status).toBe("processing");
    expect(r.error).toContain("Garmin upload failed");
    expect(store.completePending).not.toHaveBeenCalled();
    expect(store.updatePending).toHaveBeenCalledWith(
      "w1", expect.objectContaining({ phase: "processing", last_error: expect.stringContaining("failed") }),
    );
  });

  it("no usable payload → no_payload", async () => {
    store.pending.set("w1", { ...PENDING, payload: { title: "x" } });
    const r = await retryPending(deps(), "w1");
    expect(r.status).toBe("no_payload");
    expect(gw.upload).not.toHaveBeenCalled();
  });
});
