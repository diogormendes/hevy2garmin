import { describe, it, expect, vi } from "vitest";
import { createRateLimiter, isRateLimited, DEFAULT_RATE_LIMIT } from "../src/rate-limit";

/**
 * Throttling and backoff for Garmin calls (#599).
 *
 * Garmin's per-IP rate limiting is this project's most common support problem.
 * The TypeScript engine had two bare one-second sleeps and no retry at all, so
 * a rate-limit response was simply an error that failed the workout, and a
 * backlog sync issued calls as fast as the event loop allowed.
 *
 * Ported from `rate_limited_call` in the `garmin_auth` package, which is what
 * `sync.py:48` and `garmin.py:20` actually use. This repo's own `ratelimit.py`
 * is a different thing (the sign-in cooldown, #609) and is dead code.
 */

/** A limiter whose clock and sleeps are instant, so tests do not wait. */
function testLimiter(over = {}) {
  const slept: number[] = [];
  const limit = createRateLimiter({
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    ...over,
  });
  return { limit, slept };
}

describe("recognising a rate-limit response", () => {
  it("sees a 429 in a connectapi error, which is where the status ends up", () => {
    // garmin-auth puts the status in the message and types it as an auth error,
    // so there is nothing to catch by type. The message is what we have.
    expect(isRateLimited(new Error("connectapi /activitylist → 429"))).toBe(true);
  });

  it("sees a 429 from an upload, whose error is shaped differently", () => {
    expect(isRateLimited(new Error("Garmin upload failed (429): slow down"))).toBe(true);
  });

  it("recognises the phrasing as well as the number", () => {
    expect(isRateLimited(new Error("Too Many Requests"))).toBe(true);
    expect(isRateLimited(new Error("rate limit exceeded"))).toBe(true);
  });

  it("does not mistake an ordinary failure for a rate limit", () => {
    // Retrying a 404 or a 500 after 30 seconds would waste the whole budget on
    // something that will never succeed.
    expect(isRateLimited(new Error("connectapi /activity/1 → 404"))).toBe(false);
    expect(isRateLimited(new Error("Garmin upload failed (500)"))).toBe(false);
    expect(isRateLimited(new Error("socket hang up"))).toBe(false);
  });

  it("is not fooled by 429 appearing inside another number", () => {
    expect(isRateLimited(new Error("activity 24291234 not found"))).toBe(false);
  });
});

describe("pacing", () => {
  it("waits AFTER a call, not before, so the first call is not delayed", async () => {
    // Python sleeps after the call returns (`rate_limited_call`). Sleeping
    // first would add a second of latency to every sync for no benefit.
    const { limit, slept } = testLimiter();
    const order: string[] = [];

    await limit(async () => {
      order.push("call");
      return 1;
    });

    expect(order).toEqual(["call"]);
    expect(slept).toEqual([DEFAULT_RATE_LIMIT.delayMs]);
  });

  it("returns the call's value untouched", async () => {
    const { limit } = testLimiter();
    await expect(limit(async () => ({ activityId: 7 }))).resolves.toEqual({ activityId: 7 });
  });
});

describe("backoff", () => {
  it("retries a rate-limited call and succeeds", async () => {
    const { limit, slept } = testLimiter();
    let attempts = 0;
    const out = await limit(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connectapi /x → 429");
      return "ok";
    });

    expect(out).toBe("ok");
    expect(attempts).toBe(2);
    // One backoff wait, then the post-success pacing delay.
    expect(slept[0]).toBe(DEFAULT_RATE_LIMIT.baseWaitMs);
  });

  it("backs off linearly, as Python does", async () => {
    // (attempt + 1) * base, so 30s then 60s. Garmin's limit is measured in
    // minutes, so a shorter wait just burns the retry.
    const { limit, slept } = testLimiter({ maxTotalWaitMs: 10 * 60_000 });
    await expect(
      limit(async () => {
        throw new Error("429");
      }),
    ).rejects.toThrow();

    expect(slept.slice(0, 2)).toEqual([
      DEFAULT_RATE_LIMIT.baseWaitMs,
      DEFAULT_RATE_LIMIT.baseWaitMs * 2,
    ]);
  });

  it("never sleeps past its total budget", async () => {
    // A literal port would sleep 30 + 60 + 90 = 180s. On a serverless request
    // with a 300s ceiling that turns "rate limited, will retry" into "function
    // timed out", which is worse: the pending row is then parked with no error
    // at all. The budget makes the ceiling explicit.
    const { limit, slept } = testLimiter({ maxTotalWaitMs: 45_000 });
    await expect(
      limit(async () => {
        throw new Error("429");
      }),
    ).rejects.toThrow();

    const total = slept.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(45_000);
  });

  it("gives up with the rate-limit error, not a generic one", async () => {
    const { limit } = testLimiter({ maxTotalWaitMs: 0 });
    await expect(
      limit(async () => {
        throw new Error("connectapi /x → 429");
      }),
    ).rejects.toThrow(/429/);
  });

  it("does not retry an ordinary error at all", async () => {
    const { limit, slept } = testLimiter();
    let attempts = 0;
    await expect(
      limit(async () => {
        attempts += 1;
        throw new Error("Garmin upload failed (500)");
      }),
    ).rejects.toThrow(/500/);

    expect(attempts).toBe(1);
    expect(slept).toEqual([]); // no pacing delay either: nothing succeeded
  });
});
