import { describe, it, expect, vi } from "vitest";

vi.mock("./hevy-sync", () => ({ resolveHevyKey: async (k?: string | null) => k ?? "key" }));

import { fetchHevyRoutines } from "./hevy-routines";
import { HevyAuthError } from "hevy2garmin";

/**
 * The routines fetch bypassed the shared Hevy client, so it had none of the
 * handling every other Hevy call gets (#606).
 *
 * These assert the BEHAVIOUR rather than which implementation provides it, so
 * they keep passing when this file becomes a delegate to
 * `client.getAllRoutines()` after the package pin moves.
 */

function scriptedFetch(pages: Array<{ status: number; body?: unknown }>) {
  let i = 0;
  return vi.fn(async () => {
    const p = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return {
      ok: p.status >= 200 && p.status < 300,
      status: p.status,
      json: async () => p.body ?? {},
    };
  }) as unknown as typeof fetch;
}

const routine = (id: string) => ({ id, title: `Routine ${id}` });
const fast = { retryBackoffMs: 0, callDelayMs: 0 };

describe("every page is fetched", () => {
  it("collects across pages until page_count", async () => {
    const fetchImpl = scriptedFetch([
      { status: 200, body: { routines: [routine("a")], page_count: 3 } },
      { status: 200, body: { routines: [routine("b")], page_count: 3 } },
      { status: 200, body: { routines: [routine("c")], page_count: 3 } },
    ]);
    const out = await fetchHevyRoutines("key", { fetchImpl, ...fast });
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("has no page cap, so more than fifty routines all arrive", async () => {
    // The old MAX_PAGES = 5 dropped everything past fifty with no error.
    const pages = Array.from({ length: 8 }, (_, i) => ({
      status: 200,
      body: { routines: [routine(String(i))], page_count: 8 },
    }));
    const out = await fetchHevyRoutines("key", { fetchImpl: scriptedFetch(pages), ...fast });
    expect(out).toHaveLength(8);
  });
});

describe("a failure is reported, not silently truncated", () => {
  it("THROWS when a later page fails rather than returning a fragment", async () => {
    // The one that corrupts data rather than annoying someone. A rate-limited
    // fragment of twelve used to be indistinguishable from a complete list of
    // four, and the routine sync reports the fragment's size as the total.
    const fetchImpl = scriptedFetch([
      { status: 200, body: { routines: [routine("a")], page_count: 4 } },
      { status: 500 },
    ]);
    await expect(fetchHevyRoutines("key", { fetchImpl, ...fast })).rejects.toThrow();
  });

  it("gives a 401 the named error that carries the fix", async () => {
    const fetchImpl = scriptedFetch([{ status: 401 }]);
    await expect(fetchHevyRoutines("key", { fetchImpl, ...fast })).rejects.toBeInstanceOf(
      HevyAuthError,
    );
  });

  it("gives a 403 the same", async () => {
    const fetchImpl = scriptedFetch([{ status: 403 }]);
    await expect(fetchHevyRoutines("key", { fetchImpl, ...fast })).rejects.toBeInstanceOf(
      HevyAuthError,
    );
  });
});

describe("retry", () => {
  it("survives a 429 instead of ending the fetch", async () => {
    const fetchImpl = scriptedFetch([
      { status: 429 },
      { status: 200, body: { routines: [routine("a")], page_count: 1 } },
    ]);
    const out = await fetchHevyRoutines("key", { fetchImpl, ...fast });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });
});
