import { describe, it, expect, vi } from "vitest";
import { loadHrBackup, saveHrBackup, cachedHr } from "./hr-store";
import type { Sql } from "./pending-store";

/**
 * The durable backup is the one piece of HR storage that is not best effort.
 * Replacing a watch activity deletes it, and its heart rate is the most
 * valuable thing on it, so the engine refuses to replace anything it cannot
 * back up here. That makes the save path's failure behaviour as important as
 * the load path's correctness.
 */

const START = "2026-09-15T10:00:00Z";
const END = "2026-09-15T11:00:00Z";
const WORKOUT = { id: "w1", start_time: START, end_time: END };

interface Captured {
  text: string;
  values: unknown[];
}

/** A fake `sql` tag: canned rows out, statements captured. */
function fakeSql(rows: unknown[] = [], captured: Captured[] = []): Sql {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    captured.push({ text, values });
    const p = Promise.resolve(text.startsWith("INSERT") ? [] : rows);
    return Object.assign(p, { catch: p.catch.bind(p) });
  }) as unknown as Sql;
  (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return tag;
}

function throwingSql(): Sql {
  const tag = (() => {
    const p = Promise.reject(new Error("db down"));
    return Object.assign(p, { catch: p.catch.bind(p) });
  }) as unknown as Sql;
  (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return tag;
}

/** The payload shape `save_hr_backup` writes in hr.py. */
function backupRow(over: Record<string, unknown> = {}) {
  return {
    value: {
      version: 1,
      source: "garmin_activity_fit",
      source_activity_id: "777",
      workout_start: START,
      workout_end: END,
      sample_count: 2,
      hr_samples: [{ time: 0, hr: 120 }, { time: 60, hr: 140 }],
      ...over,
    },
  };
}

describe("loadHrBackup", () => {
  it("reads a backup written by the Python pipeline, key and payload unchanged", async () => {
    const captured: Captured[] = [];
    const out = await loadHrBackup(fakeSql([backupRow()], captured), WORKOUT);
    expect(captured[0].values[0]).toBe("hr_backup_w1");
    expect(out).toEqual([{ time: 0, hr: 120 }, { time: 60, hr: 140 }]);
  });

  it("rebases onto the workout's current window after an edit in Hevy", async () => {
    // The workout now starts five minutes EARLIER than when the backup was
    // taken, so every sample sits five minutes further into it. Without the
    // shift each reading would land in the wrong place in the FIT.
    const earlier = { id: "w1", start_time: "2026-09-15T09:55:00Z", end_time: END };
    expect(await loadHrBackup(fakeSql([backupRow()]), earlier)).toEqual([
      { time: 300, hr: 120 },
      { time: 360, hr: 140 },
    ]);
  });

  it("returns null when the shift pushes every sample before the new start", async () => {
    // The workout now starts five minutes LATER, so readings taken before it
    // began are not part of it and there is nothing left to embed.
    const later = { id: "w1", start_time: "2026-09-15T10:05:00Z", end_time: END };
    expect(await loadHrBackup(fakeSql([backupRow()]), later)).toBeNull();
  });

  it("drops samples that fall outside the current window", async () => {
    const short = { id: "w1", start_time: START, end_time: "2026-09-15T10:00:30Z" };
    const out = await loadHrBackup(fakeSql([backupRow()]), short);
    expect(out).toEqual([{ time: 0, hr: 120 }]);
  });

  it("refuses impossible readings rather than embedding them", async () => {
    const out = await loadHrBackup(
      fakeSql([backupRow({ hr_samples: [{ time: 0, hr: 0 }, { time: 1, hr: 900 }, { time: 2, hr: 130 }] })]),
      WORKOUT,
    );
    expect(out).toEqual([{ time: 2, hr: 130 }]);
  });

  it("returns null when there is no backup, no id, or the read fails", async () => {
    expect(await loadHrBackup(fakeSql([]), WORKOUT)).toBeNull();
    expect(await loadHrBackup(fakeSql([backupRow()]), { start_time: START })).toBeNull();
    expect(await loadHrBackup(throwingSql(), WORKOUT)).toBeNull();
  });
});

describe("saveHrBackup", () => {
  it("writes the payload hr.py writes, so either implementation can read it", async () => {
    const captured: Captured[] = [];
    await saveHrBackup(fakeSql([], captured), WORKOUT, [{ time: 0, hr: 111 }], 777);
    const insert = captured.find((c) => c.text.startsWith("INSERT"))!;
    expect(insert.values[0]).toBe("hr_backup_w1");
    expect(insert.values[1]).toMatchObject({
      version: 1,
      source: "garmin_activity_fit",
      source_activity_id: "777",
      workout_start: START,
      workout_end: END,
      sample_count: 1,
      hr_samples: [{ time: 0, hr: 111 }],
    });
  });

  it("does not let a coarser series overwrite a denser one", async () => {
    const captured: Captured[] = [];
    // The stored backup already holds 2 samples; this one holds 1.
    await saveHrBackup(fakeSql([backupRow()], captured), WORKOUT, [{ time: 0, hr: 100 }], 777);
    expect(captured.some((c) => c.text.startsWith("INSERT"))).toBe(false);
  });

  it("replaces a thinner stored backup with a denser one", async () => {
    const captured: Captured[] = [];
    await saveHrBackup(
      fakeSql([backupRow({ sample_count: 1 })], captured),
      WORKOUT,
      [{ time: 0, hr: 100 }, { time: 1, hr: 101 }, { time: 2, hr: 102 }],
      777,
    );
    expect(captured.some((c) => c.text.startsWith("INSERT"))).toBe(true);
  });

  it("THROWS when the write fails, because a failed backup must block a delete", async () => {
    // Swallowing this would let the engine believe the HR was safe and delete
    // the watch activity holding the only copy.
    await expect(
      saveHrBackup(throwingSql(), WORKOUT, [{ time: 0, hr: 100 }], 777),
    ).rejects.toThrow();
  });

  it("writes nothing for a workout with no id or no samples", async () => {
    const captured: Captured[] = [];
    const sql = fakeSql([], captured);
    await saveHrBackup(sql, { start_time: START }, [{ time: 0, hr: 100 }], 1);
    await saveHrBackup(sql, WORKOUT, [], 1);
    expect(captured).toHaveLength(0);
  });
});

describe("cachedHr", () => {
  it("reads the timed samples the engine can place in a FIT", async () => {
    const out = await cachedHr(fakeSql([{ data: { hr_samples: [{ time: 3, hr: 88 }] } }]), "w1");
    expect(out).toEqual([{ time: 3, hr: 88 }]);
  });

  it("ignores the chart's untimed reading list, which cannot be placed", async () => {
    // `data.samples` is a bare list of readings the HR chart draws. Without
    // timestamps there is no way to know where in the workout they belong.
    const out = await cachedHr(fakeSql([{ data: { samples: [100, 110, 120] } }]), "w1");
    expect(out).toBeNull();
  });

  it("returns null for a miss, an empty id, or a failed read", async () => {
    expect(await cachedHr(fakeSql([]), "w1")).toBeNull();
    expect(await cachedHr(fakeSql([]), "")).toBeNull();
    expect(await cachedHr(throwingSql(), "w1")).toBeNull();
  });
});

describe("the sync deps", () => {
  it("looks the workout up by id, so a backup can be rebased", async () => {
    const { hrDepsFor } = await import("./hr-store");
    const captured: Captured[] = [];
    const deps = hrDepsFor(fakeSql([], captured), () => new Map([["w1", WORKOUT]]));
    const save = vi.fn();
    await deps.saveBackup("w1", [{ time: 0, hr: 100 }]).then(save);
    const insert = captured.find((c) => c.text.startsWith("INSERT"))!;
    expect(insert.values[1]).toMatchObject({ workout_start: START, workout_end: END });
  });
});
