/**
 * Tests for HR fusion (#568).
 *
 * `hr_fusion` was a Settings toggle wired to nothing on the web path. The tests
 * that matter most are the FIT round-trip, which proves the extraction really
 * reads a device recording rather than merely compiling, and the HRBackupError
 * path, which is what stops a replace deleting the only copy of the watch's HR.
 */
import { describe, it, expect, vi } from "vitest";
import { deflateRawSync } from "node:zlib";
import {
  extractHevyHr,
  mergeHrSources,
  extractHrFromFit,
  looksLikeZip,
  firstFileFromZip,
  hrForSync,
  HRBackupError,
  type HrPoint,
} from "../src/hr";
import { generateFit } from "../src/fit";

const START = "2026-09-15T10:00:00Z";
const END = "2026-09-15T11:00:00Z";
const WORKOUT = { id: "w1", start_time: START, end_time: END, exercises: [] };

describe("extractHevyHr", () => {
  it("returns nothing today, because the Hevy API does not expose HR", () => {
    expect(extractHevyHr({ exercises: [] })).toEqual([]);
  });

  it("reads both shapes, so nothing changes here when Hevy starts sending it", () => {
    expect(extractHevyHr({ heart_rate: [{ time: 10, hr: 120 }, { time: 0, hr: 110 }] }))
      .toEqual([{ time: 0, hr: 110 }, { time: 10, hr: 120 }]);
    expect(extractHevyHr({ hr_samples: [[5, 130], [1, 125]] }))
      .toEqual([{ time: 1, hr: 125 }, { time: 5, hr: 130 }]);
  });

  it("drops entries with no hr and clamps negative times", () => {
    expect(extractHevyHr({ heartRate: [{ time: 1 }, { time: -5, hr: 100 }] })).toEqual([{ time: 0, hr: 100 }]);
  });
});

describe("mergeHrSources", () => {
  it("prefers the primary source within a bucket and fills gaps from the secondary", () => {
    const primary: HrPoint[] = [{ time: 0, hr: 100 }, { time: 30, hr: 140 }];
    const secondary: HrPoint[] = [{ time: 2, hr: 999 }, { time: 10, hr: 120 }, { time: 20, hr: 130 }];
    // Buckets of 10s: 0 -> primary 100 (beats the 999 in the same bucket),
    // 1 -> 120, 2 -> 130, 3 -> primary 140.
    expect(mergeHrSources(primary, secondary)).toEqual([
      { time: 0, hr: 100 }, { time: 10, hr: 120 }, { time: 20, hr: 130 }, { time: 30, hr: 140 },
    ]);
  });

  it("returns whichever side has data when the other is empty", () => {
    const s: HrPoint[] = [{ time: 5, hr: 111 }];
    expect(mergeHrSources([], s)).toEqual(s);
    expect(mergeHrSources(s, [])).toEqual(s);
    expect(mergeHrSources(null, undefined)).toEqual([]);
  });

  it("always returns samples in time order", () => {
    const out = mergeHrSources([{ time: 90, hr: 1 }], [{ time: 5, hr: 2 }, { time: 50, hr: 3 }]);
    expect(out.map((s) => s.time)).toEqual([5, 50, 90]);
  });
});

describe("extractHrFromFit", () => {
  // Build a real FIT with the package's own encoder, then read it back. This is
  // what proves the decoder path works rather than merely type-checking.
  function fitWithHr(): Uint8Array {
    const res = generateFit(
      {
        title: "HR test",
        start_time: START,
        end_time: END,
        exercises: [{ title: "Bench Press (Barbell)", sets: [{ reps: 5, weight_kg: 50 }] }],
      } as never,
      [{ time: 0, hr: 100 }, { time: 60, hr: 130 }, { time: 120, hr: 150 }],
    );
    return res.fit;
  }

  it("round-trips HR through a FIT the package itself encoded", () => {
    const out = extractHrFromFit(fitWithHr(), new Date(START), new Date(END));
    expect(out.length).toBeGreaterThan(0);
    const rates = out.map((s) => s.hr);
    expect(rates).toContain(100);
    expect(rates).toContain(150);
    // Offsets are seconds from the workout start, so the first is at or near 0.
    expect(out[0].time).toBeGreaterThanOrEqual(0);
  });

  it("drops samples outside the workout window", () => {
    // A window that ends one minute in keeps only the earliest sample.
    const out = extractHrFromFit(fitWithHr(), new Date(START), new Date("2026-09-15T10:00:30Z"));
    expect(out.every((s) => s.time <= 30)).toBe(true);
  });

  it("reads the FIT out of a zip, which is what Garmin's ORIGINAL download returns", () => {
    const fit = fitWithHr();
    const stored = makeZip(fit, 0);
    const deflated = makeZip(fit, 8);
    expect(looksLikeZip(stored)).toBe(true);
    expect(looksLikeZip(fit)).toBe(false);
    expect(extractHrFromFit(stored, new Date(START), new Date(END)).length).toBeGreaterThan(0);
    expect(extractHrFromFit(deflated, new Date(START), new Date(END)).length).toBeGreaterThan(0);
  });

  it("returns nothing for rubbish rather than breaking the sync", () => {
    expect(extractHrFromFit(new Uint8Array([1, 2, 3, 4, 5]), new Date(START), new Date(END))).toEqual([]);
    expect(firstFileFromZip(new Uint8Array([1, 2]))).toBeNull();
  });
});

/** Minimal one-entry zip: method 0 (stored) or 8 (deflate). */
function makeZip(payload: Uint8Array, method: 0 | 8): Uint8Array {
  const name = Buffer.from("ACTIVITY.fit");
  const body = method === 0 ? Buffer.from(payload) : deflateRawSync(Buffer.from(payload));
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(method, 8);
  head.writeUInt32LE(0, 14);
  head.writeUInt32LE(body.length, 18);
  head.writeUInt32LE(payload.length, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  return new Uint8Array(Buffer.concat([head, name, body]));
}

describe("hrForSync", () => {
  it("returns null when the hr_fusion toggle is off, which is what the setting should do", async () => {
    const fetchActivityFit = vi.fn();
    const r = await hrForSync(WORKOUT, { fetchActivityFit }, { enabled: false, sourceActivityId: 5 });
    expect(r).toBeNull();
    expect(fetchActivityFit).not.toHaveBeenCalled();
  });

  it("prefers the watch activity's own FIT and saves it before anything destructive", async () => {
    const saveBackup = vi.fn(async () => {});
    const fit = generateFit(
      { title: "t", start_time: START, end_time: END, exercises: [{ title: "Bench Press (Barbell)", sets: [{ reps: 1, weight_kg: 1 }] }] } as never,
      [{ time: 0, hr: 101 }],
    ).fit;
    const r = await hrForSync(
      WORKOUT,
      { fetchActivityFit: async () => fit, saveBackup },
      { sourceActivityId: 42 },
    );
    expect(r).not.toBeNull();
    expect(saveBackup).toHaveBeenCalledOnce();
    expect(saveBackup.mock.calls[0][0]).toBe("w1");
  });

  it("falls back to a durable backup from an earlier run", async () => {
    const backup: HrPoint[] = [{ time: 0, hr: 88 }];
    const r = await hrForSync(
      WORKOUT,
      { fetchActivityFit: async () => null, loadBackup: async () => backup },
      { sourceActivityId: 42 },
    );
    expect(r).toEqual(backup);
  });

  it("THROWS rather than returning null when a replace cannot secure the HR", async () => {
    // This is the important one. Returning null here would let the caller delete
    // the watch activity, destroying the only copy of its HR.
    await expect(
      hrForSync(WORKOUT, { fetchActivityFit: async () => null, loadBackup: async () => null }, { sourceActivityId: 42 }),
    ).rejects.toBeInstanceOf(HRBackupError);
  });

  it("uses the cache, then the daily feed, when nothing is being replaced", async () => {
    const cached = await hrForSync(WORKOUT, { cachedHr: async () => [{ time: 1, hr: 70 }] }, {});
    expect(cached).toEqual([{ time: 1, hr: 70 }]);

    const daily = await hrForSync(
      WORKOUT,
      { cachedHr: async () => null, dailyHr: async () => [{ time: 2, hr: 65 }] },
      {},
    );
    expect(daily).toEqual([{ time: 2, hr: 65 }]);
  });

  it("returns null instead of breaking a sync when a source throws", async () => {
    const r = await hrForSync(
      WORKOUT,
      { cachedHr: async () => { throw new Error("db down"); } },
      {},
    );
    expect(r).toBeNull();
  });

  it("never swallows HRBackupError, even though every other failure is swallowed", async () => {
    await expect(
      hrForSync(
        WORKOUT,
        {
          fetchActivityFit: async () => { throw new Error("garmin down"); },
          loadBackup: async () => null,
        },
        { sourceActivityId: 7 },
      ),
    ).rejects.toBeInstanceOf(HRBackupError);
  });
});
