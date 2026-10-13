/**
 * Tests for sync_log writing (#569).
 *
 * The bug: `sync_log` was created by the schema and read by the dashboard, and
 * nothing on the TypeScript path ever wrote to it, so the panel said "No sync
 * runs recorded yet" while syncs were happening. A user reasonably read that as
 * proof nothing had run (#565).
 *
 * The second property tested here matters as much as the first: this runs from
 * inside failure handling, so it must never throw.
 */
import { describe, it, expect, vi } from "vitest";
import { recordSyncRun, toSyncLogEntry, type SyncLogEntry } from "../src/sync/run-log";

describe("toSyncLogEntry", () => {
  it("keeps the counts a run reports", () => {
    expect(toSyncLogEntry({ synced: 3, skipped: 1, failed: 2 }, "cron")).toEqual({
      synced: 3, skipped: 1, failed: 2, trigger: "cron",
    });
  });

  it("defaults missing counts to zero rather than undefined", () => {
    expect(toSyncLogEntry({})).toEqual({ synced: 0, skipped: 0, failed: 0, trigger: "manual" });
  });

  it("refuses nonsense counts instead of writing them", () => {
    expect(toSyncLogEntry({ synced: -5, skipped: NaN, failed: 2.9 as number })).toEqual({
      synced: 0, skipped: 0, failed: 2, trigger: "manual",
    });
  });

  it("falls back to manual for an empty trigger", () => {
    expect(toSyncLogEntry({ synced: 1 }, "").trigger).toBe("manual");
  });
});

describe("recordSyncRun", () => {
  it("writes a row, which is the whole point of #569", async () => {
    const rows: SyncLogEntry[] = [];
    const store = { recordSyncLog: async (e: SyncLogEntry) => { rows.push(e); } };
    const ok = await recordSyncRun(store, { synced: 2, skipped: 1, failed: 0 }, "auto");
    expect(ok).toBe(true);
    expect(rows).toEqual([{ synced: 2, skipped: 1, failed: 0, trigger: "auto" }]);
  });

  it("never throws when the write fails, because it runs inside failure handling", async () => {
    const store = { recordSyncLog: vi.fn(async () => { throw new Error("db down"); }) };
    await expect(recordSyncRun(store, { failed: 1 }, "cron")).resolves.toBe(false);
    expect(store.recordSyncLog).toHaveBeenCalledOnce();
  });

  it("reports false rather than failing when the store does not support logging", async () => {
    await expect(recordSyncRun({}, { synced: 1 })).resolves.toBe(false);
  });

  it("records a failed run too, so a red run is visible and not just absent", async () => {
    const rows: SyncLogEntry[] = [];
    await recordSyncRun({ recordSyncLog: async (e) => { rows.push(e); } }, { failed: 3 }, "manual");
    expect(rows[0]).toEqual({ synced: 0, skipped: 0, failed: 3, trigger: "manual" });
  });
});
