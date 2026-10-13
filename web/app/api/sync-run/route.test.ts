import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  recordSyncRun: vi.fn(async (_store: unknown, _totals: unknown, _trigger: unknown) => {}),
}));
vi.mock("hevy2garmin", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordSyncRun: h.recordSyncRun,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/sync-store", () => ({ postgresSyncStore: () => ({}) }));
vi.mock("@/lib/auth", () => ({
  authEnabled: () => false,
  verifySession: async () => true,
  SESSION_COOKIE: "h2g_session",
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { POST } from "./route";

/**
 * The dashboard's own sync buttons drive `/api/sync-one` once per workout, and
 * nothing on that path ever wrote the Sync log. The panel said "No sync runs
 * recorded yet" while workouts were plainly syncing, and a user read that as
 * proof his setup was broken (#565, reported again as #611).
 *
 * A row per workout would have been the easy fix and a bad one: the loop walks
 * the whole backlog, so the panel would fill with dozens of one-line entries.
 * Python wrote one row per pass, and this endpoint is that pass's end.
 */

const post = (body: unknown) =>
  POST(
    new Request("http://h/api/sync-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("POST /api/sync-run", () => {
  it("records one row for a finished run", async () => {
    h.recordSyncRun.mockClear();
    const res = await post({ synced: 4, skipped: 2, failed: 1 });

    expect(res.status).toBe(200);
    expect(h.recordSyncRun).toHaveBeenCalledTimes(1);
    expect(h.recordSyncRun.mock.calls[0][1]).toEqual({ synced: 4, skipped: 2, failed: 1 });
  });

  it("records nothing for a run that did nothing", async () => {
    // An empty row would push real runs off the panel's ten-row window for no
    // information at all.
    h.recordSyncRun.mockClear();
    const j = await (await post({ synced: 0, skipped: 0, failed: 0 })).json();

    expect(j.recorded).toBe(false);
    expect(h.recordSyncRun).not.toHaveBeenCalled();
  });

  it("ignores nonsense counts rather than writing them", async () => {
    h.recordSyncRun.mockClear();
    await post({ synced: -5, skipped: "lots", failed: null });
    expect(h.recordSyncRun).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const res = await POST(
      new Request("http://h/api/sync-run", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(400);
  });
});
