import { describe, it, expect, vi } from "vitest";
import { mergeIntoWatchActivity, MERGE_MAX_CONSECUTIVE_FAILURES } from "../src/sync/merge";
import type { GarminGateway } from "../src/sync/gateway";
import type { MergeStore } from "../src/sync/merge";

/**
 * Two guards on the `exerciseSets` PUT path.
 *
 * An `exerciseSets` PUT replaces EVERY set on the activity, which is why a
 * backup is taken first. In TypeScript that backup lived in a local variable,
 * so it covered a throw from the push and nothing else. On a serverless request
 * an ordinary timeout kills the process between the PUT landing and the
 * restore, and the user is left with whatever partial state the merge wrote and
 * no way back (#598).
 *
 * And the push retries by bisecting the exercise names, which is the right
 * thing when one exercise is at fault and the wrong thing to repeat for ever
 * against a Garmin that is refusing everything. Python stops after three
 * consecutive failures (#585). Garmin's per-IP limiting is already this
 * project's most common support problem, so the cost is real.
 */

const ACT = {
  activityId: 900,
  manufacturer: "GARMIN",
  activityType: { typeKey: "strength_training" },
  startTimeGMT: "2026-08-01 10:00:00",
  duration: 3600,
};

const WORKOUT = {
  id: "w1",
  start_time: "2026-08-01T10:00:00Z",
  end_time: "2026-08-01T11:00:00Z",
  exercises: [{ title: "Bench Press", sets: [{ type: "normal", weight_kg: 80, reps: 5 }] }],
};

function gateway(over: Partial<GarminGateway> = {}): GarminGateway {
  return {
    findExistingActivity: vi.fn(async () => null),
    upload: vi.fn(async () => ({ uploadId: 1, activityId: 999 })),
    rename: vi.fn(async () => {}),
    describe: vi.fn(async () => {}),
    activitiesByDate: vi.fn(async () => [ACT]),
    exerciseSets: vi.fn(async () => ({ exerciseSets: [{ exerciseCategory: "BENCH_PRESS" }] })),
    putExerciseSets: vi.fn(async () => {}),
    deleteActivity: vi.fn(async () => {}),
    activityFit: vi.fn(async () => null),
    ...over,
  } as unknown as GarminGateway;
}

function mergeStore() {
  const backups = new Map<number, Record<string, unknown>>();
  let failures = 0;
  return {
    backups,
    get failures() {
      return failures;
    },
    loadMergeBackup: vi.fn(async (id: number) => backups.get(id) ?? null),
    saveMergeBackup: vi.fn(async (id: number, sets: Record<string, unknown>) => {
      backups.set(id, sets);
    }),
    clearMergeBackup: vi.fn(async (id: number) => {
      backups.delete(id);
    }),
    loadMergeFailures: vi.fn(async () => failures),
    saveMergeFailures: vi.fn(async (n: number) => {
      failures = n;
    }),
  } satisfies MergeStore & { backups: Map<number, Record<string, unknown>>; failures: number };
}

describe("the pre-merge backup survives the process (#598)", () => {
  it("writes the backup to the store before pushing anything", async () => {
    const g = gateway();
    const s = mergeStore();

    await mergeIntoWatchActivity(g, WORKOUT, { enabled: true, strategy: "merge" }, { store: s });

    expect(s.saveMergeBackup).toHaveBeenCalled();
    const [id, sets] = s.saveMergeBackup.mock.calls[0];
    expect(id).toBe(900);
    expect(sets).toMatchObject({ exerciseSets: expect.any(Array) });
  });

  it("saves the backup BEFORE the push, not after", async () => {
    const order: string[] = [];
    const g = gateway({
      putExerciseSets: vi.fn(async () => {
        order.push("push");
      }),
    });
    const s = mergeStore();
    s.saveMergeBackup.mockImplementation(async () => {
      order.push("backup");
    });

    await mergeIntoWatchActivity(g, WORKOUT, { enabled: true, strategy: "merge" }, { store: s });
    expect(order).toEqual(["backup", "push"]);
  });

  it("clears the backup once the merge has succeeded", async () => {
    // A stale backup is worse than none: a later restore would put back sets
    // from a merge that was itself superseded.
    const g = gateway();
    const s = mergeStore();

    await mergeIntoWatchActivity(g, WORKOUT, { enabled: true, strategy: "merge" }, { store: s });
    expect(s.clearMergeBackup).toHaveBeenCalledWith(900);
  });

  it("leaves the backup in place when the push failed, so a later run can restore", async () => {
    const g = gateway({
      putExerciseSets: vi.fn(async () => {
        throw new Error("Garmin said no");
      }),
    });
    const s = mergeStore();

    await mergeIntoWatchActivity(g, WORKOUT, { enabled: true, strategy: "merge" }, { store: s });
    expect(s.clearMergeBackup).not.toHaveBeenCalled();
    expect(s.backups.get(900)).toBeTruthy();
  });

  it("still works with no store, because the engine must not require one", async () => {
    const g = gateway();
    const out = await mergeIntoWatchActivity(g, WORKOUT, { enabled: true, strategy: "merge" });
    expect(out.merged).toBe(true);
  });
});

describe("the circuit breaker (#585)", () => {
  it("counts a failed push", async () => {
    const g = gateway({
      putExerciseSets: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    const s = mergeStore();

    await mergeIntoWatchActivity(g, WORKOUT, { enabled: true, strategy: "merge" }, { store: s });
    expect(s.saveMergeFailures).toHaveBeenCalledWith(1);
  });

  it("refuses to attempt a merge once the limit is reached, without calling Garmin", async () => {
    const g = gateway();
    const s = mergeStore();
    s.loadMergeFailures.mockResolvedValue(MERGE_MAX_CONSECUTIVE_FAILURES);

    const out = await mergeIntoWatchActivity(g, WORKOUT, { enabled: true, strategy: "merge" }, { store: s });

    expect(out.merged).toBe(false);
    expect(String(out.reason)).toMatch(/circuit breaker/i);
    // The point is the calls that do NOT happen. Listing activities and the
    // bisecting retry are what was being repeated for every workout.
    expect(g.activitiesByDate).not.toHaveBeenCalled();
    expect(g.putExerciseSets).not.toHaveBeenCalled();
  });

  it("resets the count on a success, so one bad workout does not trip it later", async () => {
    const g = gateway();
    const s = mergeStore();
    s.loadMergeFailures.mockResolvedValue(2);

    await mergeIntoWatchActivity(g, WORKOUT, { enabled: true, strategy: "merge" }, { store: s });
    expect(s.saveMergeFailures).toHaveBeenCalledWith(0);
  });

  it("does not trip on a no-match, which is not Garmin refusing anything", async () => {
    // Only a PUT failure counts. A workout with no matching activity is an
    // ordinary outcome, and counting it would disable merge for everyone whose
    // watch was simply not recording.
    const g = gateway({ activitiesByDate: vi.fn(async () => []) });
    const s = mergeStore();

    await mergeIntoWatchActivity(g, WORKOUT, { enabled: true, strategy: "merge" }, { store: s });
    expect(s.saveMergeFailures).not.toHaveBeenCalled();
  });
});
