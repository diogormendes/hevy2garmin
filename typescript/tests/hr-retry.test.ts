import { describe, it, expect, vi } from "vitest";
import { hrForSync } from "../src/hr";
import type { HrDeps } from "../src/hr";

/**
 * Three heart-rate problems that are really one story: HR goes missing and
 * nobody finds out.
 *
 * #600 Garmin's daily monitoring feed lags. A workout that finished recently
 * often has no readings for its window on the first ask and does on the second,
 * so Python asks twice (`sync.py:545-557`). The grace period makes this MORE
 * likely, not less, because an unattended run reaches the workout not long
 * after its window opens.
 *
 * #612 `hr_cache` had three readers and no writer outside the demo seed, so the
 * cheapest source was always empty and the dashboard's chart never rendered on
 * a real install.
 *
 * #601 when fusion is on and the activity still went up without HR, say so.
 * Garmin recomputes calories from the embedded HR, so the user otherwise
 * reports the symptom (wrong calories, #343) rather than the cause.
 */

const WORKOUT = {
  id: "w1",
  start_time: "2026-08-01T10:00:00Z",
  end_time: "2026-08-01T11:00:00Z",
};

const points = [
  { time: Date.parse("2026-08-01T10:05:00Z") / 1000, hr: 120 },
  { time: Date.parse("2026-08-01T10:06:00Z") / 1000, hr: 130 },
];

function deps(over: Partial<HrDeps> = {}): HrDeps {
  return {
    loadBackup: vi.fn(async () => null),
    saveBackup: vi.fn(async () => {}),
    cachedHr: vi.fn(async () => null),
    dailyHr: vi.fn(async () => []),
    ...over,
  } as unknown as HrDeps;
}

describe("the local cache is written, not only read (#612)", () => {
  it("caches heart rate found from the daily feed", async () => {
    const saveCache = vi.fn(async () => {});
    const d = deps({ dailyHr: vi.fn(async () => points), saveCache } as Partial<HrDeps>);

    const out = await hrForSync(WORKOUT, d, { enabled: true });

    expect(out?.length).toBeGreaterThan(0);
    expect(saveCache).toHaveBeenCalledWith("w1", expect.arrayContaining([expect.objectContaining({ hr: 120 })]));
  });

  it("does NOT rewrite the cache with what it just read from the cache", async () => {
    // Rewriting would refresh `cached_at` on every sync, so the column would
    // stop meaning "when this heart rate was actually fetched", and the chart
    // route hands that value to the user.
    const saveCache = vi.fn(async () => {});
    const d = deps({ cachedHr: vi.fn(async () => points), saveCache } as Partial<HrDeps>);

    await hrForSync(WORKOUT, d, { enabled: true });
    expect(saveCache).not.toHaveBeenCalled();
  });

  it("works without a saveCache, because the engine must not require one", async () => {
    const d = deps({ dailyHr: vi.fn(async () => points) });
    const out = await hrForSync(WORKOUT, d, { enabled: true });
    expect(out?.length).toBeGreaterThan(0);
  });

  it("caches nothing when there was no heart rate to cache", async () => {
    const saveCache = vi.fn(async () => {});
    const d = deps({ saveCache } as Partial<HrDeps>);

    await hrForSync(WORKOUT, d, { enabled: true });
    expect(saveCache).not.toHaveBeenCalled();
  });

  it("never lets a cache write failure lose the heart rate it just found", async () => {
    // The cache is an optimisation. Losing it must not cost the user the HR
    // that is about to be embedded in the FIT.
    const saveCache = vi.fn(async () => {
      throw new Error("app_cache write failed");
    });
    const d = deps({ dailyHr: vi.fn(async () => points), saveCache } as Partial<HrDeps>);

    const out = await hrForSync(WORKOUT, d, { enabled: true });
    expect(out?.length).toBeGreaterThan(0);
  });
});
