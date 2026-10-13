/**
 * Tests that the Settings a user can see actually reach the sync (#577).
 *
 * `merge.ts` and `hr.ts` were in the package, tested, and called by nothing.
 * So `merge_mode`, `merge_watch_strategy`, `merge_activity_types` and
 * `hr_fusion` were controls wired to no behaviour, which is what u/konspir
 * reported. These tests assert the behaviour each setting is supposed to
 * produce, not that a flag was read.
 */
import { describe, it, expect, vi } from "vitest";
import { syncOneWorkout } from "../../src/sync/sync-one";
import type { GarminGateway, SyncDeps } from "../../src/sync/gateway";
import type { SyncStore } from "../../src/sync/store";
import type { HrPoint } from "../../src/hr";
import { generateFit } from "../../src/fit";

/** Three hours ago, so the watch activity counts as finished. */
const START = new Date(Date.now() - 3 * 3600 * 1000);
const END = new Date(START.getTime() + 3600 * 1000);
const iso = (d: Date) => d.toISOString();
/** Garmin's own spelling: "YYYY-MM-DD HH:MM:SS", no zone marker. */
const garminTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

const WORKOUT = {
  id: "w1",
  title: "Push day",
  start_time: iso(START),
  end_time: iso(END),
  updated_at: iso(END),
  exercises: [
    { title: "Bench Press (Barbell)", sets: [{ reps: 10, weight_kg: 60 }, { reps: 8, weight_kg: 70 }] },
  ],
};

/** A watch recording that overlaps the workout, two minutes late. */
function watchActivity(over: Record<string, unknown> = {}) {
  return {
    activityId: 777,
    duration: 3600,
    startTimeGMT: garminTime(new Date(START.getTime() + 2 * 60000)),
    activityType: { typeKey: "strength_training" },
    manufacturer: "GARMIN",
    ...over,
  };
}

function store(): SyncStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isSynced: async () => false,
    loadSyncedIds: async () => new Set<string>(),
    loadPendingIds: async () => new Set<string>(),
    getPending: async () => null,
    claimPending: async (id) => {
      calls.push(`claim:${id}`);
      return true;
    },
    updatePending: async () => {},
    deletePending: async () => true,
    completePending: async (id, o) => {
      calls.push(`complete:${id}:${o.syncMethod}`);
    },
    markSynced: async (id, o) => {
      calls.push(`markSynced:${id}:${o.syncMethod}`);
    },
  };
}

function gateway(over: Partial<GarminGateway> = {}, activities: unknown[] = [watchActivity()]): GarminGateway {
  return {
    findExistingActivity: vi.fn(async () => null),
    upload: vi.fn(async () => ({ uploadId: 1, activityId: 999 })),
    rename: vi.fn(async () => {}),
    describe: vi.fn(async () => {}),
    activitiesByDate: vi.fn(async () => activities as never),
    exerciseSets: vi.fn(async () => ({ exerciseSets: [] })),
    putExerciseSets: vi.fn(async () => {}),
    deleteActivity: vi.fn(async () => {}),
    activityFit: vi.fn(async () => null),
    ...over,
  } as GarminGateway;
}

function deps(g: GarminGateway, s: SyncStore, hr?: SyncDeps["hr"]): SyncDeps {
  return {
    store: s,
    gateway: async () => g,
    fetchWorkouts: async () => [WORKOUT],
    hr,
  };
}

/** A FIT holding real HR, the shape Garmin's activity download returns. */
function fitWithHr(): Uint8Array {
  return generateFit(
    {
      title: "watch",
      start_time: iso(START),
      end_time: iso(END),
      exercises: [{ title: "Bench Press (Barbell)", sets: [{ reps: 1, weight_kg: 1 }] }],
    } as never,
    [{ time: 0, hr: 120 }, { time: 60, hr: 140 }],
  ).fit;
}

describe("merge_mode", () => {
  it("does nothing when it is off, which is how the engine behaved before", async () => {
    const g = gateway();
    const s = store();
    const r = await syncOneWorkout(deps(g, s), { dryRun: false, hrFusion: false });
    // The activity list IS read even with merge off, for the pre-upload
    // snapshot that lets a later reconcile tell our upload from something that
    // was already there. What "merge off" means is that nothing is merged, so
    // the assertion is on the merge calls rather than on the listing.
    expect(g.exerciseSets).not.toHaveBeenCalled();
    expect(g.putExerciseSets).not.toHaveBeenCalled();
    expect(g.upload).toHaveBeenCalledOnce();
    expect(r.syncMethod).toBe("upload");
  });

  it("merges into the watch activity when it is on, and uploads nothing", async () => {
    const g = gateway();
    const s = store();
    const r = await syncOneWorkout(deps(g, s), {
      dryRun: false,
      hrFusion: false,
      merge: { enabled: true, watchStrategy: "merge" },
    });
    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("merge");
    expect(r.garminActivityId).toBe(777);
    expect(r.setsPushed).toBe(2);
    expect(g.putExerciseSets).toHaveBeenCalledOnce();
    expect(g.upload).not.toHaveBeenCalled();
    expect(g.rename).toHaveBeenCalledWith(777, "Push day");
    expect(s.calls).toEqual(["markSynced:w1:merge"]);
  });

  it("never merges during a dry run, because merging writes to the user's activity", async () => {
    const g = gateway();
    const r = await syncOneWorkout(deps(g, store()), {
      dryRun: true,
      merge: { enabled: true, watchStrategy: "merge" },
    });
    expect(g.activitiesByDate).not.toHaveBeenCalled();
    expect(g.putExerciseSets).not.toHaveBeenCalled();
    expect(r.status).toBe("dry_run");
  });

  it("falls back to an upload when nothing matches, and says why", async () => {
    const g = gateway({}, []);
    const r = await syncOneWorkout(deps(g, store()), {
      dryRun: false,
      hrFusion: false,
      merge: { enabled: true, watchStrategy: "merge" },
    });
    expect(r.syncMethod).toBe("upload");
    expect(g.upload).toHaveBeenCalledOnce();
    expect(r.mergeFallbackReason).toMatch(/no matching Garmin activity/);
  });
});

describe("merge_watch_strategy", () => {
  it("describe keeps the watch activity and pushes no sets", async () => {
    const g = gateway();
    const r = await syncOneWorkout(deps(g, store()), {
      dryRun: false,
      hrFusion: false,
      merge: { enabled: true, watchStrategy: "describe" },
    });
    expect(r.syncMethod).toBe("merge");
    expect(r.setsPushed).toBe(0);
    expect(g.putExerciseSets).not.toHaveBeenCalled();
    expect(g.describe).toHaveBeenCalledOnce();
    expect(g.deleteActivity).not.toHaveBeenCalled();
  });

  it("replace uploads a named activity and then removes the watch copy", async () => {
    const g = gateway({ activityFit: vi.fn(async () => fitWithHr()) });
    const s = store();
    const saveBackup = vi.fn(async () => {});
    const r = await syncOneWorkout(deps(g, s, { saveBackup }), {
      dryRun: false,
      merge: { enabled: true, watchStrategy: "replace" },
    });
    expect(r.syncMethod).toBe("upload");
    expect(g.upload).toHaveBeenCalledOnce();
    expect(g.deleteActivity).toHaveBeenCalledWith(777);
    // The watch's HR is saved BEFORE the delete, or the delete destroys it.
    expect(saveBackup).toHaveBeenCalledOnce();
    expect(s.calls).toContain("complete:w1:upload");
  });

  it("replace excludes the activity it is replacing from the dedup lookup", async () => {
    // Otherwise layer 2 matches the very activity we are about to delete and
    // skips the upload that is meant to take its place.
    const findExistingActivity = vi.fn(async () => null);
    const g = gateway({ findExistingActivity, activityFit: vi.fn(async () => fitWithHr()) });
    await syncOneWorkout(deps(g, store(), { saveBackup: async () => {} }), {
      dryRun: false,
      merge: { enabled: true, watchStrategy: "replace" },
    });
    expect(findExistingActivity).toHaveBeenCalledWith(expect.any(String), [777]);
  });

  it("does not delete the watch activity when the upload produced no activity id", async () => {
    const g = gateway({
      upload: vi.fn(async () => ({ uploadId: 1, activityId: null })),
      activityFit: vi.fn(async () => fitWithHr()),
    });
    await syncOneWorkout(deps(g, store(), { saveBackup: async () => {} }), {
      dryRun: false,
      merge: { enabled: true, watchStrategy: "replace" },
    });
    expect(g.deleteActivity).not.toHaveBeenCalled();
  });

  it("keeps the sync green when the delete fails, and reports it", async () => {
    const g = gateway({
      deleteActivity: vi.fn(async () => {
        throw new Error("403");
      }),
      activityFit: vi.fn(async () => fitWithHr()),
    });
    const r = await syncOneWorkout(deps(g, store(), { saveBackup: async () => {} }), {
      dryRun: false,
      merge: { enabled: true, watchStrategy: "replace" },
    });
    expect(r.status).toBe("synced");
    expect(r.mergeFallbackReason).toMatch(/could not be deleted/);
  });

  it("merges the sets in place rather than deleting the only copy of the watch HR", async () => {
    // No FIT and no durable backup: hrForSync raises HRBackupError. Deleting
    // here would lose the watch's heart rate for good, so the engine keeps the
    // activity and merges into it instead (#244).
    const g = gateway({ activityFit: vi.fn(async () => null) });
    const s = store();
    const r = await syncOneWorkout(deps(g, s, { loadBackup: async () => null }), {
      dryRun: false,
      merge: { enabled: true, watchStrategy: "replace" },
    });
    expect(r.syncMethod).toBe("merge");
    expect(r.garminActivityId).toBe(777);
    expect(g.deleteActivity).not.toHaveBeenCalled();
    expect(g.upload).not.toHaveBeenCalled();
    expect(g.putExerciseSets).toHaveBeenCalledOnce();
    expect(r.mergeFallbackReason).toMatch(/could not be extracted/);
    expect(s.calls).toEqual(["markSynced:w1:merge"]);
  });

  it("uploads alongside the watch activity when even the in-place merge fails", async () => {
    const g = gateway({
      activityFit: vi.fn(async () => null),
      putExerciseSets: vi.fn(async () => {
        throw new Error("Garmin said no");
      }),
    });
    const r = await syncOneWorkout(deps(g, store(), { loadBackup: async () => null }), {
      dryRun: false,
      merge: { enabled: true, watchStrategy: "replace" },
    });
    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("upload");
    expect(g.upload).toHaveBeenCalledOnce();
    expect(g.deleteActivity).not.toHaveBeenCalled(); // the watch copy survives
  });
});

describe("merge_activity_types", () => {
  const cardio = [watchActivity({ activityType: { typeKey: "indoor_cardio" } })];

  it("skips an activity whose type is not in the list", async () => {
    const g = gateway({}, cardio);
    const r = await syncOneWorkout(deps(g, store()), {
      dryRun: false,
      hrFusion: false,
      merge: { enabled: true, watchStrategy: "merge" },
    });
    expect(r.syncMethod).toBe("upload");
    expect(g.putExerciseSets).not.toHaveBeenCalled();
  });

  it("merges into it once the user adds that type, which is the whole point of the setting", async () => {
    const g = gateway({}, cardio);
    const r = await syncOneWorkout(deps(g, store()), {
      dryRun: false,
      hrFusion: false,
      merge: {
        enabled: true,
        watchStrategy: "merge",
        activityTypes: ["strength_training", "indoor_cardio"],
      },
    });
    expect(r.syncMethod).toBe("merge");
    expect(g.putExerciseSets).toHaveBeenCalledOnce();
  });
});

describe("hr_fusion", () => {
  const cached: HrPoint[] = [{ time: 0, hr: 111 }];

  it("asks for heart rate when the toggle is on", async () => {
    const cachedHr = vi.fn(async () => cached);
    await syncOneWorkout(deps(gateway({}, []), store(), { cachedHr }), {
      dryRun: false,
      hrFusion: true,
    });
    expect(cachedHr).toHaveBeenCalledWith("w1");
  });

  it("asks for nothing when the toggle is off", async () => {
    const cachedHr = vi.fn(async () => cached);
    await syncOneWorkout(deps(gateway({}, []), store(), { cachedHr }), {
      dryRun: false,
      hrFusion: false,
    });
    expect(cachedHr).not.toHaveBeenCalled();
  });

  it("embeds the heart rate it found in the uploaded FIT", async () => {
    const withHr = await syncOneWorkout(
      deps(gateway({}, []), store(), { cachedHr: async () => [{ time: 0, hr: 150 }, { time: 60, hr: 150 }] }),
      { dryRun: false, hrFusion: true },
    );
    const without = await syncOneWorkout(deps(gateway({}, []), store()), {
      dryRun: false,
      hrFusion: false,
    });
    expect(withHr.fitStats?.avgHr).toBe(150);
    expect(without.fitStats?.avgHr).toBeNull();
  });

  it("still protects the watch HR on a replace even with fusion switched off", async () => {
    // Turning the toggle off must not become permission to delete the only
    // recording of the user's heart rate.
    const saveBackup = vi.fn(async () => {});
    const g = gateway({ activityFit: vi.fn(async () => fitWithHr()) });
    await syncOneWorkout(deps(g, store(), { saveBackup }), {
      dryRun: false,
      hrFusion: false,
      merge: { enabled: true, watchStrategy: "replace" },
    });
    expect(saveBackup).toHaveBeenCalledOnce();
    expect(g.deleteActivity).toHaveBeenCalledWith(777);
  });

  it("asks for no heart rate during a dry run, which would be a Garmin call for nothing", async () => {
    const cachedHr = vi.fn(async () => cached);
    await syncOneWorkout(deps(gateway({}, []), store(), { cachedHr }), { dryRun: true });
    expect(cachedHr).not.toHaveBeenCalled();
  });

  it("falls back to Garmin's daily monitoring when there is no denser source", async () => {
    // The last resort, and the only source that covers a workout the watch
    // never recorded as an activity.
    const dailyHeartRate = vi.fn(async () => [
      [START.getTime(), 130],
      [START.getTime() + 600_000, 130],
    ] as Array<[number, number | null]>);
    const r = await syncOneWorkout(deps(gateway({ dailyHeartRate }, []), store()), {
      dryRun: false,
      hrFusion: true,
    });
    expect(dailyHeartRate).toHaveBeenCalledWith(START.toISOString().slice(0, 10));
    expect(r.fitStats?.avgHr).toBe(130);
  });

  it("prefers the host's own cache over the daily feed", async () => {
    const dailyHeartRate = vi.fn(async () => [] as Array<[number, number | null]>);
    await syncOneWorkout(
      deps(gateway({ dailyHeartRate }, []), store(), {
        cachedHr: async () => [{ time: 0, hr: 145 }],
      }),
      { dryRun: false, hrFusion: true },
    );
    expect(dailyHeartRate).not.toHaveBeenCalled();
  });
});

describe("the profile and timing settings", () => {
  it("encodes the FIT for the user, not for a default 80 kg person born in 1990", async () => {
    const heavier = await syncOneWorkout(deps(gateway({}, []), store()), {
      dryRun: false,
      hrFusion: false,
      profile: { weightKg: 120, birthYear: 1970, vo2max: 35 },
    });
    const dflt = await syncOneWorkout(deps(gateway({}, []), store()), {
      dryRun: false,
      hrFusion: false,
    });
    expect(heavier.fitStats?.calories).not.toBe(dflt.fitStats?.calories);
  });

  it("carries the user's set timing into a merge", async () => {
    const g = gateway();
    await syncOneWorkout(deps(g, store()), {
      dryRun: false,
      hrFusion: false,
      merge: {
        enabled: true,
        watchStrategy: "merge",
        timing: { workingSetS: 90, restSetsS: 200, warmupSetS: 30, restExercisesS: 300 },
      },
    });
    const [, payload] = (g.putExerciseSets as ReturnType<typeof vi.fn>).mock.calls[0];
    const sets = (payload as { exerciseSets: Array<{ duration: number; setType: string }> }).exerciseSets;
    // The activity lasts an hour and the nominal plan is longer, so everything
    // is scaled down together. What matters is the ratio the user asked for:
    // a rest set is 200/90 times an active one.
    const active = sets.find((x) => x.setType === "ACTIVE")!.duration;
    const rest = sets.find((x) => x.setType === "REST")!.duration;
    expect(rest / active).toBeCloseTo(200 / 90, 2);
  });
});
