import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Safety-gating tests for POST /api/sync-one.
 *
 * The route's whole reason to exist is that a live Garmin upload must fire ONLY
 * when the caller both (a) explicitly asks for it and (b) is authorized —
 * otherwise it runs the engine in dry-run. We mock the engine + auth + cookies
 * so no network or DB is touched, and assert exactly which (dryRun) the engine
 * is invoked with (or that it is never invoked).
 */

const syncOneWorkout = vi.fn();
vi.mock("@/lib/sync-one", () => ({
  syncOneWorkout: (...a: unknown[]) => syncOneWorkout(...a),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

// Typed with its real arity so `mock.calls[0][1]` is the totals object rather
// than an index into an empty tuple.
const recordSyncRun = vi.fn(
  async (_store: unknown, _totals: unknown, _trigger: unknown): Promise<void> => {},
);
vi.mock("hevy2garmin", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordSyncRun: (s: unknown, t: unknown, g: unknown) => recordSyncRun(s, t, g),
}));
vi.mock("@/lib/sync-store", () => ({ postgresSyncStore: () => ({}) }));

const authEnabled = vi.fn();
const verifySession = vi.fn();
vi.mock("@/lib/auth", () => ({
  authEnabled: (...a: unknown[]) => authEnabled(...a),
  verifySession: (...a: unknown[]) => verifySession(...a),
  SESSION_COOKIE: "h2g_session",
}));

const cookieGet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (...a: unknown[]) => cookieGet(...a) }),
}));

import { POST } from "./route";

const DRY = {
  status: "dry_run",
  dryRun: true,
  wouldUpload: true,
  dedupDecision: "would_upload",
  remaining: 3,
};
const LIVE = {
  status: "synced",
  dryRun: false,
  garminActivityId: 555,
  dedupDecision: "would_upload",
  remaining: 2,
};

function req(
  url: string,
  body: unknown = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  syncOneWorkout.mockResolvedValue(DRY);
  authEnabled.mockReturnValue(true);
  verifySession.mockReturnValue(false);
  cookieGet.mockReturnValue(undefined);
});

describe("POST /api/sync-one — dry-run / auth gating", () => {
  it("no live requested → dry-run (engine called with dryRun:true)", async () => {
    const res = await POST(req("http://h/api/sync-one", {}));
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
  });

  it("live requested but NOT authorized → 401, engine never called", async () => {
    const res = await POST(req("http://h/api/sync-one", { live: 1 }));
    expect(res.status).toBe(401);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("live + valid session → live run (engine called with dryRun:false)", async () => {
    cookieGet.mockReturnValue({ value: "cookie" });
    verifySession.mockReturnValue(true);
    syncOneWorkout.mockResolvedValue(LIVE);
    const res = await POST(req("http://h/api/sync-one", { live: true }));
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });

  it("live + auth DISABLED (no password configured) → authorized → live run", async () => {
    authEnabled.mockReturnValue(false);
    syncOneWorkout.mockResolvedValue(LIVE);
    const res = await POST(req("http://h/api/sync-one?live=1", {}));
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });

  it("live via CRON_SECRET bearer token → live run", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await POST(
      req("http://h/api/sync-one", { live: 1 }, { authorization: "Bearer s3cret" }),
    );
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });

  it("live with a WRONG CRON_SECRET and no session → 401, engine never called", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await POST(
      req("http://h/api/sync-one", { live: 1 }, { authorization: "Bearer nope" }),
    );
    expect(res.status).toBe(401);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("invalid JSON body → 400, engine never called", async () => {
    const bad = new Request("http://h/api/sync-one", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });
});


/**
 * A manual sync has to leave a trace (#611, and again after konspir reported it
 * a third time on r/Hevy).
 *
 * The writer used to live in sync-loop.tsx, so only "Sync all" recorded
 * anything. The dashboard's own "Sync now" button and the per-workout button on
 * Workouts both sync correctly and log nothing, and a user watching an empty
 * panel has no way to tell that from a sync that never ran. Twice now the fix
 * wired one more caller and called the feature done.
 *
 * It belongs in the route. A component can forget; a route every caller must go
 * through cannot.
 */
describe("a live sync records a run", () => {
  beforeEach(() => {
    recordSyncRun.mockClear();
    syncOneWorkout.mockReset();
    authEnabled.mockReturnValue(false);
  });

  it("records one run for the dashboard's Sync now", async () => {
    syncOneWorkout.mockResolvedValue(LIVE);
    await POST(req("http://h/api/sync-one?live=1"));
    expect(recordSyncRun).toHaveBeenCalledTimes(1);
    expect(recordSyncRun.mock.calls[0][1]).toEqual({ synced: 1, skipped: 0, failed: 0 });
    expect(recordSyncRun.mock.calls[0][2]).toBe("manual (one)");
  });

  it("counts a skip as a skip, not a sync", async () => {
    syncOneWorkout.mockResolvedValue({ ...LIVE, status: "skipped" });
    await POST(req("http://h/api/sync-one?live=1"));
    expect(recordSyncRun.mock.calls[0][1]).toEqual({ synced: 0, skipped: 1, failed: 0 });
  });

  it("counts a failure as a failure", async () => {
    syncOneWorkout.mockResolvedValue({ ...LIVE, status: "failed" });
    await POST(req("http://h/api/sync-one?live=1"));
    expect(recordSyncRun.mock.calls[0][1]).toEqual({ synced: 0, skipped: 0, failed: 1 });
  });

  it("records NOTHING when there was no candidate", async () => {
    // Pressing Sync now with everything already synced returns status "none".
    // The first version of this fix counted every unrecognised status as a
    // success, so it wrote a false "1 synced" row every time.
    syncOneWorkout.mockResolvedValue({ ...LIVE, status: "none" });
    await POST(req("http://h/api/sync-one?live=1"));
    expect(recordSyncRun).not.toHaveBeenCalled();
  });

  it("records NOTHING for a preview, which is not a sync", async () => {
    // sync-panel's Preview hits the same route without live=1. Logging it would
    // fill the panel with runs that never uploaded anything.
    syncOneWorkout.mockResolvedValue(DRY);
    await POST(req("http://h/api/sync-one"));
    expect(recordSyncRun).not.toHaveBeenCalled();
  });

  it("records NOTHING when the caller is batching", async () => {
    // sync-loop drives this route once per workout and posts its own totals to
    // /api/sync-run at the end. Without the opt-out a ten-workout run would
    // write eleven rows.
    syncOneWorkout.mockResolvedValue(LIVE);
    await POST(req("http://h/api/sync-one?live=1&batch=1"));
    expect(recordSyncRun).not.toHaveBeenCalled();
  });

  it("still answers normally when recording fails", async () => {
    // The log is an audit trail, not the job. Losing it must not turn a
    // successful upload into an error the user sees.
    syncOneWorkout.mockResolvedValue(LIVE);
    recordSyncRun.mockRejectedValueOnce(new Error("sync_log is missing"));
    const res = await POST(req("http://h/api/sync-one?live=1"));
    expect(res.status).toBe(200);
  });
});
