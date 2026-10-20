import { describe, it, expect } from "vitest";
import { parseStartDate, withinSyncWindow } from "./sync-window";

const w = (id: string, start_time: unknown) => ({ id, start_time });

describe("reading the setting", () => {
  it("accepts a plain date", () => {
    expect(parseStartDate("2026-09-01")?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it.each(["", "   ", "not a date", "01/09/2026", "2026-9-1", null, undefined, 42])(
    "treats %p as no window rather than as a filter",
    (v) => {
      // The failure that matters: a value that cannot be read must never mean
      // "hide everything", because the user would see an empty list and no cause.
      expect(parseStartDate(v as unknown)).toBeNull();
    },
  );
});

describe("filtering", () => {
  const list = [
    w("old", "2025-06-01T10:00:00Z"),
    w("onTheDay", "2026-09-01T07:30:00Z"),
    w("new", "2026-09-15T18:00:00Z"),
  ];

  it("keeps everything when no date is set", () => {
    expect(withinSyncWindow(list, null).map((x) => x.id)).toEqual(["old", "onTheDay", "new"]);
  });

  it("drops what finished before the date", () => {
    const kept = withinSyncWindow(list, parseStartDate("2026-09-01"));
    expect(kept.map((x) => x.id)).toEqual(["onTheDay", "new"]);
  });

  it("keeps a workout ON the start date", () => {
    // The user picked the day they started, so that day counts as inside.
    const kept = withinSyncWindow([w("onTheDay", "2026-09-01T00:00:00Z")], parseStartDate("2026-09-01"));
    expect(kept).toHaveLength(1);
  });

  it("keeps a workout whose time cannot be read", () => {
    // Silently hiding it would be data loss the user cannot discover.
    const kept = withinSyncWindow([w("odd", "whenever"), w("none", null)], parseStartDate("2026-09-01"));
    expect(kept.map((x) => x.id)).toEqual(["odd", "none"]);
  });

  it("does not mutate the list it was given", () => {
    const src = [...list];
    withinSyncWindow(src, parseStartDate("2026-09-01"));
    expect(src).toHaveLength(3);
  });
});
