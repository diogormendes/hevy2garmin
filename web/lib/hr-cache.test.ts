import { describe, it, expect } from "vitest";
import { saveHrCache } from "./hr-store";

/**
 * `hr_cache` had three readers and no writer outside the demo seed (#612), so
 * the dashboard's per-workout chart was empty on every real install while
 * working perfectly on the demo.
 *
 * The subtle part is that the two readers want different shapes and neither is
 * wrong. The chart reads `data.samples`, a bare list of readings. The sync's
 * `cachedHr` reads `data.hr_samples`, a `{time, hr}` series it can put in a
 * FIT. The demo seed wrote only `samples`, which is why `cachedHr` returned
 * null even there.
 */

function sqlSpy() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve([]);
  }) as unknown as Parameters<typeof saveHrCache>[0] & {
    json: (v: unknown) => unknown;
  };
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql, calls };
}

const samples = [
  { time: 0, hr: 120 },
  { time: 10, hr: 130 },
];

describe("saveHrCache", () => {
  it("writes both shapes, so both readers see something", async () => {
    const { sql, calls } = sqlSpy();
    await saveHrCache(sql, "w1", samples);

    expect(calls).toHaveLength(1);
    const value = calls[0].values.find((v) => v && typeof v === "object" && "hr_samples" in v) as {
      hr_samples: unknown[];
      samples: unknown[];
    };
    expect(value.hr_samples).toEqual(samples);
    expect(value.samples).toEqual([120, 130]); // the chart wants bare numbers
  });

  it("writes nothing for a workout with no heart rate", async () => {
    // An empty row would make the chart request a fetch that returns nothing,
    // and would make `cached_at` claim we looked when we found none.
    const { sql, calls } = sqlSpy();
    await saveHrCache(sql, "w1", []);
    expect(calls).toHaveLength(0);
  });

  it("writes nothing without a workout id", async () => {
    const { sql, calls } = sqlSpy();
    await saveHrCache(sql, "", samples);
    expect(calls).toHaveLength(0);
  });

  it("upserts rather than failing on a workout synced twice", async () => {
    const { sql, calls } = sqlSpy();
    await saveHrCache(sql, "w1", samples);
    expect(calls[0].text).toContain("ON CONFLICT");
  });
});
