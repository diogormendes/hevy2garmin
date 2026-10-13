import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The intervals.icu cleanup reaching THIS app (#586, second half).
 *
 * The engine grew the hook in 0.9.0 and the package has its own tests for what
 * the hook does. What those cannot cover is whether anything here ever hands it
 * to the engine, which is the shape of bug this repo keeps producing: a
 * capability that exists, has tests, and is never called.
 *
 * So these assert the binding only. It is opt-in through two environment
 * variables, and with neither set the engine must receive nothing at all rather
 * than a function that quietly does nothing, because the engine skips the whole
 * step on undefined.
 */
const h = vi.hoisted(() => ({
  engine: {
    syncOneWorkout: vi.fn(async (_deps: unknown, _opts: unknown) => ({ status: "dry_run" })),
    listCandidates: vi.fn(async (_deps: unknown) => [] as unknown[]),
    garminGateway: vi.fn((client: unknown) => ({ client })),
  },
  ps: { isSynced: vi.fn(async () => false) },
}));
vi.mock("hevy2garmin", async (importOriginal) => ({ ...(await importOriginal<object>()), ...h.engine }));
vi.mock("./pending-store", () => h.ps);
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("./garmin-upload", () => ({ getGarminClient: async () => ({}) }));
vi.mock("./hevy-sync", () => ({ fetchAllWorkouts: async () => [] }));

import { buildSyncDeps } from "./sync-one";

const ENV = { ...process.env };
beforeEach(() => {
  delete process.env.INTERVALS_API_KEY;
  delete process.env.INTERVALS_ATHLETE_ID;
});
afterEach(() => {
  process.env = { ...ENV };
});

const sql = (() => {}) as never;

describe("the engine is given the cleanup hook", () => {
  it("passes a function when both credentials are set", () => {
    process.env.INTERVALS_API_KEY = "k";
    process.env.INTERVALS_ATHLETE_ID = "i12345";
    expect(buildSyncDeps(sql).onWatchActivityDeleted).toBeTypeOf("function");
  });
});

describe("it stays opt-in", () => {
  it("passes nothing when neither credential is set", () => {
    expect(buildSyncDeps(sql).onWatchActivityDeleted).toBeUndefined();
  });

  it("passes nothing when only the key is set", () => {
    process.env.INTERVALS_API_KEY = "k";
    expect(buildSyncDeps(sql).onWatchActivityDeleted).toBeUndefined();
  });

  it("passes nothing when only the athlete is set", () => {
    process.env.INTERVALS_ATHLETE_ID = "i12345";
    expect(buildSyncDeps(sql).onWatchActivityDeleted).toBeUndefined();
  });
});
