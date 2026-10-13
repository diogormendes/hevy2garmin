import { describe, it, expect, vi } from "vitest";
import { mergeIntoWatchActivity } from "../src/sync/merge";
import type { GarminGateway } from "../src/sync/gateway";

/**
 * Merging into an activity we uploaded ourselves (#597).
 *
 * A user edits a workout in Hevy, changes a weight or adds a set, and re-syncs.
 * The match is the activity we uploaded the first time. Python pushes the
 * corrected sets into it; TypeScript refused, fell through to the start-time
 * lookup, found the same activity and did rename plus description only. The
 * title changed and the sets did not.
 *
 * The three lines that allow it are not the work. The work is the read-back.
 * Garmin can accept an `exerciseSets` PUT, answer success, and silently drop
 * the exercise names, leaving every set as "Choose an Exercise". On a watch
 * activity that is tolerable, because the watch's own data is the point and our
 * sets are an enhancement. On our OWN upload the activity exists only to carry
 * those sets, so a silent drop makes it worse than before while reporting
 * success. Ported from `_names_applied` in `merge.py:53-75`.
 */

const DEV_ACT = {
  activityId: 900,
  manufacturer: "DEVELOPMENT",
  activityType: { typeKey: "strength_training" },
  startTimeGMT: "2026-08-01 10:00:00",
  duration: 3600,
};

const WATCH_ACT = { ...DEV_ACT, activityId: 901, manufacturer: "GARMIN" };

const WORKOUT = {
  id: "w1",
  start_time: "2026-08-01T10:00:00Z",
  end_time: "2026-08-01T11:00:00Z",
  exercises: [{ title: "Bench Press", sets: [{ type: "normal", weight_kg: 80, reps: 5 }] }],
};

const named = (category: string) => ({
  exerciseSets: [{ setType: "ACTIVE", exercises: [{ category }] }],
});

function gateway(act: Record<string, unknown>, readBack: unknown, over: Partial<GarminGateway> = {}) {
  let reads = 0;
  return {
    findExistingActivity: vi.fn(async () => null),
    upload: vi.fn(async () => ({ uploadId: 1, activityId: 999 })),
    rename: vi.fn(async () => {}),
    describe: vi.fn(async () => {}),
    activitiesByDate: vi.fn(async () => [act]),
    exerciseSets: vi.fn(async () => {
      // First call is the pre-merge backup, second is the verification read.
      reads += 1;
      if (reads === 1) return named("BENCH_PRESS");
      if (readBack instanceof Error) throw readBack;
      return readBack;
    }),
    putExerciseSets: vi.fn(async () => {}),
    deleteActivity: vi.fn(async () => {}),
    activityFit: vi.fn(async () => null),
    ...over,
  } as unknown as GarminGateway;
}

// No real waiting in tests. The production default gives Garmin time to process
// the PUT before reading it back.
const fast = { enabled: true, strategy: "merge" as const, verifyDelayMs: 0 };

describe("merge no longer refuses our own uploads (#597)", () => {
  it("pushes the edited sets into an activity we uploaded", async () => {
    const g = gateway(DEV_ACT, named("BENCH_PRESS"));
    const out = await mergeIntoWatchActivity(g, WORKOUT, fast);

    expect(out.merged).toBe(true);
    expect(out.activityId).toBe(900);
    expect(g.putExerciseSets).toHaveBeenCalled();
  });
});

describe("the read-back that has to come with it", () => {
  it("restores and asks for a fresh upload when Garmin dropped the names", async () => {
    // Every set came back UNKNOWN. The activity is now worse than before the
    // merge, so put the old sets back and upload a named activity instead.
    const g = gateway(DEV_ACT, named("UNKNOWN"));
    const out = await mergeIntoWatchActivity(g, WORKOUT, fast);

    expect(out.merged).toBe(false);
    expect(out.forceFreshUpload).toBe(true);
    // Two pushes: the merge, then the restore.
    expect(g.putExerciseSets).toHaveBeenCalledTimes(2);
  });

  it("treats one surviving real category as applied", async () => {
    // Any, not all. A partial drop still leaves a usable activity, and throwing
    // it away would cost the user the sets that did land.
    const g = gateway(DEV_ACT, {
      exerciseSets: [
        { setType: "ACTIVE", exercises: [{ category: "UNKNOWN" }] },
        { setType: "ACTIVE", exercises: [{ category: "BENCH_PRESS" }] },
      ],
    });
    const out = await mergeIntoWatchActivity(g, WORKOUT, fast);
    expect(out.merged).toBe(true);
  });

  it("treats no active sets at all as dropped", async () => {
    // A successful read that comes back empty is evidence the names are gone,
    // which is different from not being able to read at all.
    const g = gateway(DEV_ACT, { exerciseSets: [] });
    const out = await mergeIntoWatchActivity(g, WORKOUT, fast);
    expect(out.forceFreshUpload).toBe(true);
  });

  it("treats an unreadable activity as applied, rather than discarding the merge", async () => {
    // The opposite direction from the empty case, and deliberate. An exception
    // says nothing about what Garmin kept, so failing closed here would throw
    // away a merge that probably worked because of a transient read error.
    const g = gateway(DEV_ACT, new Error("Garmin read failed"));
    const out = await mergeIntoWatchActivity(g, WORKOUT, fast);

    expect(out.merged).toBe(true);
    expect(g.putExerciseSets).toHaveBeenCalledTimes(1); // no restore
  });

  it("skips the verification for a watch activity under the merge strategy", async () => {
    // We keep the watch activity knowing Garmin will not show our names on it.
    // Verifying would restore and discard a merge we meant to keep.
    const g = gateway(WATCH_ACT, named("UNKNOWN"));
    const out = await mergeIntoWatchActivity(g, WORKOUT, fast);

    expect(out.merged).toBe(true);
    expect(g.putExerciseSets).toHaveBeenCalledTimes(1);
  });
});
