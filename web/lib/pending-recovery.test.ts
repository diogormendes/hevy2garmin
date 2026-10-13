import { describe, it, expect, vi, beforeEach } from "vitest";

/** Recovery logic is tested in the hevy2garmin package; this covers the wiring. */
const h = vi.hoisted(() => ({
  engine: {
    reconcilePending: vi.fn(async (_deps: unknown, _id: string) => ({ status: "no_activity", garminActivityId: null, error: null })),
    retryPending: vi.fn(async (_deps: unknown, _id: string, _opts: unknown) => ({ status: "synced", garminActivityId: 555, error: null })),
  },
  ps: { getPending: vi.fn(async (_id: string, _sql: unknown) => null) },
  settings: {
    loadSyncSettings: vi.fn(async (_sql: unknown) => ({
      merge: { enabled: true, watchStrategy: "merge" },
      hrFusion: true,
      descriptionEnabled: true,
      profile: { age: 30 },
    })),
  },
}));
vi.mock("hevy2garmin", async (importOriginal) => ({ ...(await importOriginal<object>()), ...h.engine }));
vi.mock("./pending-store", () => h.ps);
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("./garmin-upload", () => ({ getGarminClient: async () => ({}) }));
vi.mock("./hevy-sync", () => ({ fetchAllWorkouts: async () => [] }));
vi.mock("./sync-settings", () => h.settings);

import { reconcilePending, retryPending } from "./pending-recovery";
import type { buildSyncDeps } from "./sync-one";

type Deps = ReturnType<typeof buildSyncDeps>;
const SQL = { tag: "sql" } as never;
beforeEach(() => { h.engine.reconcilePending.mockClear(); h.engine.retryPending.mockClear(); h.ps.getPending.mockClear(); });

describe("pending-recovery (route shim)", () => {
  it("reconcilePending forwards the id with sql-bound deps", async () => {
    const r = await reconcilePending("w1", {}, SQL);
    expect(r.status).toBe("no_activity");
    const [deps, id] = h.engine.reconcilePending.mock.calls[0];
    expect(id).toBe("w1");
    await (deps as Deps).store.getPending("w1");
    expect(h.ps.getPending).toHaveBeenCalledWith("w1", SQL);
  });

  it("retryPending forwards the id, and an explicit option beats the saved one", async () => {
    const r = await retryPending("w1", { descriptionEnabled: false }, SQL);
    expect(r.status).toBe("synced");
    expect(h.engine.retryPending.mock.calls[0][1]).toBe("w1");
    expect(h.engine.retryPending.mock.calls[0][2]).toMatchObject({ descriptionEnabled: false });
  });

  it("hands the retry the saved sync settings, not engine defaults", async () => {
    // A retry re-runs the ordinary sync now, so without these it would run with
    // merge off and no user profile, and come back missing the very things
    // #614 was about.
    await retryPending("w2", undefined, SQL);
    const opts = h.engine.retryPending.mock.calls[0][2] as Record<string, unknown>;
    expect(Object.keys(opts).sort()).toEqual(
      ["descriptionEnabled", "hrFusion", "merge", "profile"].sort(),
    );
  });
});
