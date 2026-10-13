import { describe, it, expect } from "vitest";
import { resolveExclusiveMatches } from "../src/match";
import type { HevyDt, GarminAct } from "../src/match";

const d = (s: string): Date => new Date(s + "Z");

describe("resolveExclusiveMatches — one Garmin activity, one Hevy workout", () => {
  // The real 2026-03-15 pair. Upper starts at the same second as the activity, so the
  // package's first pass pairs them. Lower starts 44 minutes later, has no activity of
  // its own, and the package's +/-6h fallback hands it the same one.
  const hevy: HevyDt[] = [
    { hevyId: "upper", date: d("2026-03-15T21:13:49") },
    { hevyId: "lower", date: d("2026-03-15T21:57:45") },
  ];
  const acts: GarminAct[] = [{ gmt: "2026-03-15 21:13:49", aid: 22186889389 }];

  it("keeps the workout whose start actually matches and drops the fallback claim", () => {
    const r = resolveExclusiveMatches(
      [{ hevyId: "upper", aid: 22186889389 }, { hevyId: "lower", aid: 22186889389 }],
      hevy, acts,
    );
    expect(r.kept).toEqual([{ hevyId: "upper", aid: 22186889389, deltaMs: 0 }]);
    expect(r.dropped.map((m) => m.hevyId)).toEqual(["lower"]);
  });

  it("leaves an uncontested activity alone whatever the gap", () => {
    const r = resolveExclusiveMatches(
      [{ hevyId: "lower", aid: 22186889389 }],
      hevy, acts,
    );
    expect(r.kept.map((m) => m.hevyId)).toEqual(["lower"]);
    expect(r.dropped).toEqual([]);
  });

  it("breaks an exact tie the same way every run, so a re-run is a no-op", () => {
    const tied: HevyDt[] = [
      { hevyId: "bbb", date: d("2026-03-15T21:13:49") },
      { hevyId: "aaa", date: d("2026-03-15T21:13:49") },
    ];
    const first = resolveExclusiveMatches(
      [{ hevyId: "bbb", aid: 1 }, { hevyId: "aaa", aid: 1 }], tied, [{ gmt: "2026-03-15 21:13:49", aid: 1 }]);
    const second = resolveExclusiveMatches(
      [{ hevyId: "aaa", aid: 1 }, { hevyId: "bbb", aid: 1 }], tied, [{ gmt: "2026-03-15 21:13:49", aid: 1 }]);
    expect(first.kept).toEqual(second.kept);
    expect(first.kept[0].hevyId).toBe("aaa");
  });

  it("resolves each activity on its own", () => {
    const many: HevyDt[] = [
      { hevyId: "a", date: d("2026-03-15T21:13:49") },
      { hevyId: "b", date: d("2026-03-15T21:57:45") },
      { hevyId: "c", date: d("2026-03-29T23:31:08") },
    ];
    const acts2: GarminAct[] = [
      { gmt: "2026-03-15 21:13:49", aid: 11 },
      { gmt: "2026-03-29 23:31:08", aid: 22 },
    ];
    const r = resolveExclusiveMatches(
      [{ hevyId: "a", aid: 11 }, { hevyId: "b", aid: 11 }, { hevyId: "c", aid: 22 }], many, acts2);
    expect(r.kept.map((m) => m.hevyId).sort()).toEqual(["a", "c"]);
    expect(r.dropped.map((m) => m.hevyId)).toEqual(["b"]);
  });

  it("drops a match whose workout or activity it cannot time, rather than guessing", () => {
    const r = resolveExclusiveMatches([{ hevyId: "ghost", aid: 99 }], hevy, acts);
    expect(r.kept).toEqual([]);
    expect(r.dropped.map((m) => m.hevyId)).toEqual(["ghost"]);
  });
});
