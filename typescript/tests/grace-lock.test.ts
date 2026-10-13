/**
 * Tests for the grace period and the sync lock (#570).
 *
 * The grace period is the wait that lets the watch upload its own activity
 * before we upload ours. Without it the merge path has nothing to match, so the
 * test that matters most is the one asserting the engine really defers rather
 * than merely computing a boolean.
 *
 * The lock's important property is the one Python got slightly wrong: a run
 * that is taken over after going stale must not be able to release the lock the
 * new run now holds.
 */
import { describe, it, expect, vi } from "vitest";
import {
  checkGracePeriod,
  isWithinGracePeriod,
  workoutAgeMinutes,
  DEFAULT_GRACE_MINUTES,
} from "../src/sync/grace";
import {
  acquireSyncLock,
  withSyncLock,
  createMemoryLockBackend,
  SYNC_LOCK_TIMEOUT_MS,
} from "../src/sync/lock";
import { syncOneWorkout } from "../src/sync/sync-one";
import type { SyncStore } from "../src/sync/store";
import type { SyncDeps } from "../src/sync/gateway";

const NOW = new Date("2026-09-15T12:00:00Z");
/** A workout that ended `mins` minutes before NOW. */
function endedMinutesAgo(mins: number) {
  return { end_time: new Date(NOW.getTime() - mins * 60000).toISOString() };
}

describe("workoutAgeMinutes", () => {
  it("measures from end_time, in minutes", () => {
    expect(workoutAgeMinutes(endedMinutesAgo(45), NOW)).toBeCloseTo(45);
  });

  it("reads the camelCase spelling too", () => {
    expect(workoutAgeMinutes({ endTime: "2026-09-15T11:00:00Z" }, NOW)).toBeCloseTo(60);
  });

  it("returns null when there is no usable end time", () => {
    expect(workoutAgeMinutes({}, NOW)).toBeNull();
    expect(workoutAgeMinutes({ end_time: "" }, NOW)).toBeNull();
    expect(workoutAgeMinutes({ end_time: "not a date" }, NOW)).toBeNull();
  });

  it("goes negative for an end time in the future, which clock skew produces", () => {
    expect(workoutAgeMinutes(endedMinutesAgo(-10), NOW)).toBeCloseTo(-10);
  });
});

describe("checkGracePeriod", () => {
  it("holds back a workout that just ended", () => {
    const c = checkGracePeriod(endedMinutesAgo(5), 120, NOW);
    expect(c.withinGrace).toBe(true);
    expect(c.ageMinutes).toBeCloseTo(5);
    expect(c.graceMinutes).toBe(120);
  });

  it("releases a workout once the wait has passed", () => {
    expect(isWithinGracePeriod(endedMinutesAgo(121), 120, NOW)).toBe(false);
  });

  it("treats the boundary as released, matching the Python comparison", () => {
    // Python: age_min < grace_minutes. Exactly at the limit is NOT within grace.
    expect(isWithinGracePeriod(endedMinutesAgo(120), 120, NOW)).toBe(false);
  });

  it("holds back a workout whose end time is in the future, because waiting is safe", () => {
    expect(isWithinGracePeriod(endedMinutesAgo(-30), 120, NOW)).toBe(true);
  });

  it("turns the wait off at zero or below", () => {
    expect(isWithinGracePeriod(endedMinutesAgo(1), 0, NOW)).toBe(false);
    expect(isWithinGracePeriod(endedMinutesAgo(1), -5, NOW)).toBe(false);
  });

  it("never holds back a workout with no end time, which would defer it forever", () => {
    expect(isWithinGracePeriod({}, 120, NOW)).toBe(false);
  });

  it("defaults to the Python config's 120 minutes", () => {
    expect(DEFAULT_GRACE_MINUTES).toBe(120);
    expect(isWithinGracePeriod(endedMinutesAgo(119), undefined, NOW)).toBe(true);
    expect(isWithinGracePeriod(endedMinutesAgo(121), undefined, NOW)).toBe(false);
  });
});

describe("the sync lock", () => {
  it("lets one holder in and turns the second away without waiting", async () => {
    const backend = createMemoryLockBackend();
    const first = await acquireSyncLock({ backend });
    expect(first).not.toBeNull();
    expect(await acquireSyncLock({ backend })).toBeNull();
  });

  it("frees the lock on release", async () => {
    const backend = createMemoryLockBackend();
    const first = await acquireSyncLock({ backend });
    await first!.release();
    const second = await acquireSyncLock({ backend });
    expect(second).not.toBeNull();
  });

  it("takes over a lock held past the timeout, so one crash cannot wedge sync forever", async () => {
    const backend = createMemoryLockBackend();
    let clock = 1_000_000;
    const now = () => clock;
    const stuck = await acquireSyncLock({ backend, now });
    expect(stuck).not.toBeNull();

    clock += SYNC_LOCK_TIMEOUT_MS - 1;
    expect(await acquireSyncLock({ backend, now })).toBeNull();

    clock += 1;
    const takeover = await acquireSyncLock({ backend, now });
    expect(takeover).not.toBeNull();
    expect(takeover!.token).not.toBe(stuck!.token);
  });

  it("will not let a taken-over holder release the new holder's lock", async () => {
    // Python force-releases the semaphore, which can free a lock another run has
    // since taken. Tokens are what stop that here.
    const backend = createMemoryLockBackend();
    let clock = 0;
    const now = () => clock;
    const stuck = await acquireSyncLock({ backend, now });
    clock += SYNC_LOCK_TIMEOUT_MS;
    const takeover = await acquireSyncLock({ backend, now });

    await stuck!.release(); // the stale run finally finishes
    expect(await acquireSyncLock({ backend, now })).toBeNull(); // still held by takeover
    await takeover!.release();
    expect(await acquireSyncLock({ backend, now })).not.toBeNull();
  });

  it("releasing twice is harmless", async () => {
    const backend = createMemoryLockBackend();
    const h = await acquireSyncLock({ backend });
    await h!.release();
    const second = await acquireSyncLock({ backend });
    await h!.release(); // must NOT free the lock the second run holds
    expect(await acquireSyncLock({ backend })).toBeNull();
    await second!.release();
  });

  it("withSyncLock runs the work once and reports the busy case instead of queueing", async () => {
    const backend = createMemoryLockBackend();
    let running = 0;
    let peak = 0;
    const work = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
      return "done";
    };
    const [a, b] = await Promise.all([
      withSyncLock(work, { backend }),
      withSyncLock(work, { backend }),
    ]);
    expect(peak).toBe(1);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    expect(a.ran ? a.value : b.value).toBe("done");
  });

  it("releases the lock when the work throws, and still reports the failure", async () => {
    const backend = createMemoryLockBackend();
    await expect(
      withSyncLock(async () => {
        throw new Error("sync blew up");
      }, { backend }),
    ).rejects.toThrow("sync blew up");
    expect(await acquireSyncLock({ backend })).not.toBeNull();
  });

  it("uses a durable backend when one is supplied, which is what serverless needs", async () => {
    // A process-local lock guarantees nothing when each request is a new
    // process, so the backend is the seam a consumer replaces.
    const rows = new Map<string, string>();
    const durable = {
      acquire: vi.fn(async (key: string) => {
        if (rows.has(key)) return null;
        rows.set(key, "tok");
        return "tok";
      }),
      release: vi.fn(async (key: string, token: string) => {
        if (rows.get(key) === token) rows.delete(key);
      }),
    };
    const h = await acquireSyncLock({ backend: durable, key: "sync" });
    expect(durable.acquire).toHaveBeenCalledWith("sync", SYNC_LOCK_TIMEOUT_MS, expect.any(Number));
    expect(await acquireSyncLock({ backend: durable })).toBeNull();
    await h!.release();
    expect(durable.release).toHaveBeenCalledWith("sync", "tok");
  });
});

/** A store that answers "nothing is synced" and records any mutation. */
function freshStore(): SyncStore & { mutations: string[] } {
  const mutations: string[] = [];
  return {
    mutations,
    isSynced: async () => false,
    loadSyncedIds: async () => new Set<string>(),
    loadPendingIds: async () => new Set<string>(),
    getPending: async () => null,
    claimPending: async (id) => {
      mutations.push(`claim:${id}`);
      return true;
    },
    updatePending: async (id) => {
      mutations.push(`update:${id}`);
    },
    deletePending: async (id) => {
      mutations.push(`delete:${id}`);
      return true;
    },
    completePending: async (id) => {
      mutations.push(`complete:${id}`);
    },
    markSynced: async (id) => {
      mutations.push(`markSynced:${id}`);
    },
  };
}

describe("syncOneWorkout honours the grace period", () => {
  const justFinished = {
    id: "w-new",
    title: "Push day",
    start_time: new Date(Date.now() - 65 * 60000).toISOString(),
    end_time: new Date(Date.now() - 5 * 60000).toISOString(),
    exercises: [],
  };

  function depsFor(store: SyncStore, findExisting = vi.fn(async () => null)): SyncDeps {
    return {
      store,
      fetchWorkouts: async () => [justFinished],
      gateway: async () =>
        ({
          findExistingActivity: findExisting,
          rename: vi.fn(),
          describe: vi.fn(),
          upload: vi.fn(),
        }) as unknown as Awaited<ReturnType<SyncDeps["gateway"]>>,
    } as unknown as SyncDeps;
  }

  it("defers a just-finished workout and never touches Garmin or the store", async () => {
    const store = freshStore();
    const findExisting = vi.fn(async () => null);
    const res = await syncOneWorkout(depsFor(store, findExisting), {
      dryRun: false,
      respectGrace: true,
    });
    expect(res.status).toBe("deferred");
    expect(res.dedupDecision).toBe("within_grace");
    expect(res.wouldUpload).toBe(false);
    expect(res.workout?.hevy_id).toBe("w-new");
    expect(findExisting).not.toHaveBeenCalled();
    expect(store.mutations).toEqual([]);
  });

  it("does not defer when the caller did not ask for the wait, which is Sync Now", async () => {
    const res = await syncOneWorkout(depsFor(freshStore()), { dryRun: true });
    expect(res.status).toBe("dry_run");
    expect(res.dedupDecision).toBe("would_upload");
  });

  it("does not defer once the wait has elapsed", async () => {
    const res = await syncOneWorkout(depsFor(freshStore()), {
      dryRun: true,
      respectGrace: true,
      graceMinutes: 2,
    });
    expect(res.status).toBe("dry_run");
    expect(res.dedupDecision).toBe("would_upload");
  });

  it("defers in dry run too, because a live run right now would not upload either", async () => {
    const res = await syncOneWorkout(depsFor(freshStore()), { dryRun: true, respectGrace: true });
    expect(res.status).toBe("deferred");
    expect(res.dedupDecision).toBe("within_grace");
  });
});
