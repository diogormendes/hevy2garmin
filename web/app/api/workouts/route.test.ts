import { describe, it, expect, vi, beforeEach } from "vitest";
import { ledgerSql } from "@/lib/test-ledger-sql";

const db = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => db.sql }));

import { GET } from "./route";

/** GET /api/workouts, which the Expo app reads, carries resynced_at (#709). */
const row = (over: Record<string, unknown> = {}) => ({
  hevy_id: "w1",
  title: "Push",
  synced_at: "2026-10-07T10:56:00.000Z",
  resynced_at: null,
  calories: 300,
  avg_hr: 120,
  garmin_activity_id: "4242",
  status: "success",
  ...over,
});
let queries: string[];
function withRows(terminal: Array<Record<string, unknown>>, pending: Array<Record<string, unknown>> = []) {
  const l = ledgerSql(terminal, pending);
  db.sql = l.sql;
  queries = l.queries;
}
const workouts = async () => ((await (await GET()).json()) as { workouts: Array<Record<string, unknown>> }).workouts;

beforeEach(() => withRows([row()]));

describe("GET /api/workouts: resynced_at", () => {
  it("is selected, and rows are still ordered by synced_at", async () => {
    await workouts();
    const select = queries.find((q) => q.includes("FROM synced_workouts"))!;
    expect(select).toMatch(/resynced_at/);
    expect(select).toMatch(/ORDER BY synced_at DESC/);
  });

  it("is passed through when the row was resynced", async () => {
    withRows([row({ resynced_at: "2026-10-09T14:52:00.000Z" })]);
    const [w] = await workouts();
    expect(w.synced_at).toBe("2026-10-07T10:56:00.000Z");
    expect(w.resynced_at).toBe("2026-10-09T14:52:00.000Z");
  });

  it("is null when it was not", async () => {
    const [w] = await workouts();
    expect(w.resynced_at).toBeNull();
  });

  it("is null on an in-flight row", async () => {
    withRows([], [{ hevy_id: "p1", phase: "processing", created_at: "2026-10-09T10:00:00Z", payload_title: "Pull" }]);
    const [w] = await workouts();
    expect(w.kind).toBe("pending");
    expect(w.resynced_at).toBeNull();
  });
});
