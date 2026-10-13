import { describe, it, expect } from "vitest";
import { cooldownRemaining, clearCooldown, formatCooldown } from "./garmin-cooldown";

/**
 * The Garmin sign-in cooldown was written and never read (#609).
 *
 * `/api/garmin-rate-limited` computed a 2h-to-24h backoff and stored it, and
 * nothing blocked on it or cleared it. So a rate-limited user could press sign
 * in again straight away, which deepens Garmin's own timer, and `hits` climbed
 * for ever so the next cooldown always started at the 24 hour cap.
 */

function sqlWith(value: unknown) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    const p = Promise.resolve(value === undefined ? [] : [{ value }]);
    // The real tagged template exposes .catch on its promise; so does this.
    return p;
  }) as never;
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql, calls };
}

describe("cooldownRemaining", () => {
  it("reports the seconds left while a cooldown is running", async () => {
    const until = new Date(Date.now() + 90 * 60_000).toISOString();
    const { sql } = sqlWith({ until, hits: 2, seconds: 14400 });

    const left = await cooldownRemaining(sql);
    expect(left).toBeGreaterThan(89 * 60);
    expect(left).toBeLessThanOrEqual(90 * 60);
  });

  it("reports zero once the window has passed", async () => {
    const until = new Date(Date.now() - 60_000).toISOString();
    const { sql } = sqlWith({ until, hits: 1 });
    expect(await cooldownRemaining(sql)).toBe(0);
  });

  it("reports zero when nothing has ever been recorded", async () => {
    const { sql } = sqlWith(undefined);
    expect(await cooldownRemaining(sql)).toBe(0);
  });

  it("reports zero for an unparseable timestamp rather than locking the user out", async () => {
    // A bad row must not become a permanent block on signing in. The cooldown
    // is a courtesy to Garmin, not a security control.
    const { sql } = sqlWith({ until: "not a date" });
    expect(await cooldownRemaining(sql)).toBe(0);
  });

  it("reports zero for a cleared cooldown", async () => {
    const { sql } = sqlWith({ until: null, hits: 0, seconds: 0 });
    expect(await cooldownRemaining(sql)).toBe(0);
  });
});

describe("clearCooldown", () => {
  it("resets the hit count, not only the deadline", async () => {
    // Clearing `until` alone would leave `hits` high, so the NEXT rate limit
    // would start at the 24 hour cap however long ago the last one was.
    const { sql, calls } = sqlWith(undefined);
    await clearCooldown(sql);

    const written = calls[0].values.find((v) => v && typeof v === "object") as {
      until: unknown;
      hits: number;
    };
    expect(written.until).toBeNull();
    expect(written.hits).toBe(0);
  });
});

describe("formatCooldown", () => {
  it("says hours and minutes the way Python does", () => {
    expect(formatCooldown(105 * 60)).toBe("about 1h 45m");
    expect(formatCooldown(120 * 60)).toBe("about 2h");
    expect(formatCooldown(5 * 60)).toBe("about 5m");
  });
});
