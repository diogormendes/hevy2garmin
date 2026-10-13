import { describe, it, expect } from "vitest";
import { postgresLockBackend } from "./sync-lock-store";

/**
 * The durable backend the engine's sync lock was written to accept.
 *
 * `lock.ts` shipped in #570 with tests and nothing ever called it (#604). Its
 * built-in in-process backend is not enough on serverless, where each request
 * can be a fresh process, so a lock in memory looks like a lock while
 * guaranteeing nothing.
 */

/** A sql tag backed by one in-memory row, enough to exercise the protocol. */
function sqlWithRow(initial: unknown = undefined) {
  const store = new Map<string, unknown>();
  if (initial !== undefined) store.set("row", initial);
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("SELECT")) {
      const v = store.get("row");
      return Promise.resolve(v === undefined ? [] : [{ value: v }]);
    }
    if (text.includes("DELETE")) {
      store.delete("row");
      return Promise.resolve([]);
    }
    // INSERT ... ON CONFLICT: the json value is the second interpolation.
    store.set("row", values.find((v) => v && typeof v === "object"));
    return Promise.resolve([]);
  }) as never;
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql, store };
}

const STALE_MS = 300_000;

describe("taking the lock", () => {
  it("claims a free lock and returns a token", async () => {
    const { sql } = sqlWithRow();
    const token = await postgresLockBackend(sql).acquire("sync", STALE_MS, 1000);
    expect(typeof token).toBe("string");
  });

  it("refuses when someone else holds a fresh one", async () => {
    const { sql } = sqlWithRow({ token: "theirs", takenAt: 1000 });
    const token = await postgresLockBackend(sql).acquire("sync", STALE_MS, 2000);
    expect(token).toBeNull();
  });

  it("takes over a lock held past the timeout", async () => {
    // Without this one crashed run blocks every later run for ever, which is
    // worse than the overlap the lock exists to prevent.
    const { sql } = sqlWithRow({ token: "abandoned", takenAt: 0 });
    const token = await postgresLockBackend(sql).acquire("sync", STALE_MS, STALE_MS + 1);
    expect(typeof token).toBe("string");
  });
});

describe("releasing it", () => {
  it("frees a lock we still hold", async () => {
    const { sql, store } = sqlWithRow();
    const backend = postgresLockBackend(sql);
    const token = (await backend.acquire("sync", STALE_MS, 1000))!;

    await backend.release("sync", token);
    expect(store.get("row")).toBeUndefined();
  });

  it("does NOT free a lock someone else has since taken", async () => {
    // A run taken over as stale must not cut the new holder loose, which is the
    // whole reason the engine hands out a token rather than a boolean.
    const { sql, store } = sqlWithRow({ token: "the new holder", takenAt: 9999 });
    await postgresLockBackend(sql).release("sync", "my old token");
    expect(store.get("row")).toEqual({ token: "the new holder", takenAt: 9999 });
  });
});
