import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { markSynced, type Sql } from "./pending-store";
import { SCHEMA_STATEMENTS } from "./schema";

/**
 * markSynced against a real Postgres, because what is under test is how its
 * upsert treats an existing row, and only Postgres can answer that (#709).
 *
 * A resync rewrites a synced workout's row. The Workouts and History pages
 * date and sort rows by `synced_at`, so a resync must keep it and record
 * `resynced_at` instead, or a workout from days ago jumps to the top. Every
 * other write keeps the old behaviour: `synced_at` moves to now.
 *
 * Runs only when TEST_DATABASE_URL names a database it may write to; it
 * creates the schema there and deletes only the rows it made.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("markSynced against Postgres (#709)", () => {
  let db: ReturnType<typeof postgres>;
  let sql: Sql;
  const ids: string[] = [];
  const id = (name: string) => {
    const hevyId = `test-709-${name}-${Date.now()}`;
    ids.push(hevyId);
    return hevyId;
  };
  const PAST = "2026-10-01T10:00:00.000Z";

  async function row(hevyId: string) {
    const rows = await db`
      SELECT synced_at, resynced_at, title, hevy_updated_at, sync_method, status
      FROM synced_workouts WHERE hevy_id = ${hevyId}
    `;
    return rows[0] as {
      synced_at: Date;
      resynced_at: Date | null;
      title: string;
      hevy_updated_at: string | null;
      sync_method: string;
      status: string;
    };
  }

  /** A row synced at a known moment in the past, so "kept" and "moved" are unambiguous. */
  async function syncedInThePast(hevyId: string) {
    await markSynced(hevyId, { title: "Push", hevyUpdatedAt: "2026-10-01T09:59:00Z", syncMethod: "merge" }, sql);
    await db`UPDATE synced_workouts SET synced_at = ${PAST} WHERE hevy_id = ${hevyId}`;
  }

  beforeAll(async () => {
    db = postgres(url!, { prepare: false, onnotice: () => {} });
    sql = db as unknown as Sql;
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
  });

  afterAll(async () => {
    if (ids.length) await db`DELETE FROM synced_workouts WHERE hevy_id = ANY(${ids})`;
    await db.end();
  });

  it("a first sync sets synced_at and no resynced_at", async () => {
    const hevyId = id("first");
    await markSynced(hevyId, { title: "Push", syncMethod: "upload" }, sql);
    const r = await row(hevyId);
    expect(r.synced_at).toBeInstanceOf(Date);
    expect(r.resynced_at).toBeNull();
  });

  it("a resync keeps synced_at, sets resynced_at, and writes the new version", async () => {
    const hevyId = id("resync");
    await syncedInThePast(hevyId);
    await markSynced(
      hevyId,
      { title: "Push (edited)", hevyUpdatedAt: "2026-10-09T14:52:00Z", syncMethod: "merge", resync: true },
      sql,
    );
    const r = await row(hevyId);
    expect(r.synced_at.toISOString()).toBe(PAST);
    expect(r.resynced_at).toBeInstanceOf(Date);
    expect(r.resynced_at!.getTime()).toBeGreaterThan(new Date(PAST).getTime());
    expect(r.title).toBe("Push (edited)");
    expect(r.hevy_updated_at).toBe("2026-10-09T14:52:00Z");
    expect(r.status).toBe("success");
  });

  it("a second resync moves resynced_at and still keeps synced_at", async () => {
    const hevyId = id("twice");
    await syncedInThePast(hevyId);
    await markSynced(hevyId, { title: "Push", resync: true }, sql);
    await db`UPDATE synced_workouts SET resynced_at = '2026-10-05T10:00:00Z' WHERE hevy_id = ${hevyId}`;
    await markSynced(hevyId, { title: "Push", resync: true }, sql);
    const r = await row(hevyId);
    expect(r.synced_at.toISOString()).toBe(PAST);
    expect(r.resynced_at!.getTime()).toBeGreaterThan(new Date("2026-10-05T10:00:00Z").getTime());
  });

  it("a normal sync over an existing row moves synced_at and leaves resynced_at alone", async () => {
    const hevyId = id("normal");
    await syncedInThePast(hevyId);
    await markSynced(hevyId, { title: "Push", resync: true }, sql);
    const resyncedAt = (await row(hevyId)).resynced_at!.toISOString();

    await markSynced(hevyId, { title: "Push again", syncMethod: "upload" }, sql);
    const r = await row(hevyId);
    expect(r.synced_at.getTime()).toBeGreaterThan(new Date(PAST).getTime());
    expect(r.resynced_at!.toISOString()).toBe(resyncedAt);
    expect(r.title).toBe("Push again");
  });

  it("a resync of a row that is not there is a first sync: no resynced_at", async () => {
    const hevyId = id("resync-new");
    await markSynced(hevyId, { title: "Push", resync: true }, sql);
    const r = await row(hevyId);
    expect(r.synced_at).toBeInstanceOf(Date);
    expect(r.resynced_at).toBeNull();
  });
});
