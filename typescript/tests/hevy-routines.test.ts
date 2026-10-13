import { describe, it, expect, vi } from "vitest";
import { HevyClient, HevyAuthError } from "../src/hevy";

/**
 * The routines fetch bypassed `HevyClient` entirely, so it inherited none of
 * what `_get` gives every other Hevy call (#606).
 *
 * Four things were lost, and the second is the one that corrupts data rather
 * than merely annoying someone.
 *
 * Retry was gone, so a single 429 ended the fetch.
 *
 * A 429 after page one returned whatever had been collected so far, so the
 * caller could not tell a complete list of four routines from a rate-limited
 * fragment of twelve. The routine sync then iterates that fragment and reports
 * its own total as though it were everything.
 *
 * `HevyAuthError` was gone, so a 401 surfaced as a bare status code where
 * Python gives the user the fix: check Hevy Pro, regenerate the key.
 *
 * And the pacing between calls was gone, against an API that rate-limits.
 */

/** A fetch that answers from a script of responses, recording the URLs asked. */
function scriptedFetch(pages: Array<{ status: number; body?: unknown }>) {
  const urls: string[] = [];
  let i = 0;
  const impl = vi.fn(async (url: string) => {
    urls.push(String(url));
    const p = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return {
      ok: p.status >= 200 && p.status < 300,
      status: p.status,
      json: async () => p.body ?? {},
      text: async () => JSON.stringify(p.body ?? {}),
    };
  });
  return { impl: impl as unknown as typeof fetch, urls };
}

const routine = (id: string) => ({ id, title: `Routine ${id}` });
const client = (f: typeof fetch) =>
  new HevyClient("key", undefined, { fetchImpl: f, callDelayMs: 0, retryBackoffMs: 0 });

describe("getAllRoutines walks every page", () => {
  it("collects routines across pages until page_count is reached", async () => {
    const { impl } = scriptedFetch([
      { status: 200, body: { routines: [routine("a")], page_count: 3 } },
      { status: 200, body: { routines: [routine("b")], page_count: 3 } },
      { status: 200, body: { routines: [routine("c")], page_count: 3 } },
    ]);

    const out = await client(impl).getAllRoutines();
    expect(out.map((r: { id: string }) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("has no page cap, so a user with many routines gets all of them", async () => {
    // The web version stopped at MAX_PAGES = 5, so anyone past 50 routines
    // silently lost the rest with no error and no indication.
    const pages = Array.from({ length: 8 }, (_, i) => ({
      status: 200,
      body: { routines: [routine(String(i))], page_count: 8 },
    }));
    const { impl } = scriptedFetch(pages);

    const out = await client(impl).getAllRoutines();
    expect(out).toHaveLength(8);
  });

  it("stops on an empty page rather than looping for ever", async () => {
    const { impl } = scriptedFetch([
      { status: 200, body: { routines: [routine("a")], page_count: 99 } },
      { status: 200, body: { routines: [] , page_count: 99 } },
    ]);
    const out = await client(impl).getAllRoutines();
    expect(out).toHaveLength(1);
  });
});

describe("a failure is reported, not silently truncated", () => {
  it("THROWS when a later page fails, rather than returning a fragment", async () => {
    // The important one. Returning what it had made a rate-limited fragment
    // indistinguishable from a complete list, and the routine sync then
    // reports that fragment's size as the total.
    const { impl } = scriptedFetch([
      { status: 200, body: { routines: [routine("a")], page_count: 4 } },
      { status: 500 },
    ]);

    await expect(client(impl).getAllRoutines()).rejects.toThrow();
  });

  it("turns a 401 into HevyAuthError, which carries the actual fix", async () => {
    const { impl } = scriptedFetch([{ status: 401 }]);
    await expect(client(impl).getAllRoutines()).rejects.toBeInstanceOf(HevyAuthError);
  });

  it("turns a 403 into HevyAuthError too", async () => {
    const { impl } = scriptedFetch([{ status: 403 }]);
    await expect(client(impl).getAllRoutines()).rejects.toBeInstanceOf(HevyAuthError);
  });
});

describe("retry", () => {
  it("retries a 429 and carries on", async () => {
    // A single 429 used to end the fetch. It is now the case the shared client
    // was already written to survive.
    const { impl } = scriptedFetch([
      { status: 429 },
      { status: 200, body: { routines: [routine("a")], page_count: 1 } },
    ]);

    const out = await client(impl).getAllRoutines();
    expect(out.map((r: { id: string }) => r.id)).toEqual(["a"]);
  });
});
