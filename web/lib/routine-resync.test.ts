import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./garmin-upload", () => ({ getGarminClient: async () => ({}) }));
vi.mock("./garmin-delete", () => ({ garminDelete: vi.fn(async () => {}) }));

import { syncRoutine, reconcileMissingRoutineWorkouts } from "./garmin-routine-sync";
import { ROUTINE_DESC_MARKER, routineToGarminWorkout } from "./garmin-workout";
import { workoutContentHash } from "./garmin-workout-library";
import { garminDelete } from "./garmin-delete";

/**
 * Re-syncing a routine used to add a second Garmin workout rather than
 * replacing the first (#602), and every sync recreated whether anything had
 * changed or not (#603). The `ON CONFLICT` then repointed the database row at
 * the newest id, so every earlier copy became an orphan nothing tracked.
 *
 * Press Sync three times, three copies.
 */

const ROUTINE = { id: "r1", title: "Push Day", exercises: [] };

/** A sql tag that answers `rows` and records what it was asked. */
function sqlWith(rows: unknown[]) {
  const texts: string[] = [];
  let calls = 0;
  const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    texts.push(strings.join("?"));
    calls += 1;
    const p = Promise.resolve(calls === 1 ? rows : []);
    return p;
  }) as never;
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql, texts };
}

type FakeClient = { connectapi: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

function client(library: unknown[], created = 900): FakeClient {
  return {
    connectapi: vi.fn(async () => library),
    post: vi.fn(async () => ({ workoutId: created })),
  };
}

beforeEach(() => {
  (garminDelete as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe("an unchanged routine is left alone (#603)", () => {
  /** The hash this routine's generated payload actually produces. */
  const currentHash = workoutContentHash(routineToGarminWorkout(ROUTINE));

  it("skips without writing to Garmin when the content hash matches", async () => {
    const c = client([], 900);
    const { sql } = sqlWith([
      { garmin_workout_id: "77", status: "success", content_hash: currentHash },
    ]);

    const out = await syncRoutine(ROUTINE, sql, { garminClientFactory: async () => c as never });

    expect(out.status).toBe("skipped");
    expect(c.post).not.toHaveBeenCalled();
    expect(garminDelete).not.toHaveBeenCalled();
  });

  it("re-syncs when the payload changed", async () => {
    const c = client([], 905);
    const { sql } = sqlWith([
      { garmin_workout_id: "77", status: "success", content_hash: "an older payload" },
    ]);

    const out = await syncRoutine(ROUTINE, sql, { garminClientFactory: async () => c as never });
    expect(out.status).toBe("synced");
    expect(c.post).toHaveBeenCalled();
  });

  it("does not skip a routine whose schedule is still pending", async () => {
    // That row is unfinished. Skipping it would strand the schedule retry.
    const c = client([], 906);
    const { sql } = sqlWith([
      { garmin_workout_id: "77", status: "schedule_pending", content_hash: currentHash },
    ]);

    const out = await syncRoutine(ROUTINE, sql, { garminClientFactory: async () => c as never });
    expect(out.status).toBe("synced");
  });

  it("re-syncs anyway when forced", async () => {
    const c = client([], 907);
    const { sql } = sqlWith([
      { garmin_workout_id: "77", status: "success", content_hash: currentHash },
    ]);

    const out = await syncRoutine(ROUTINE, sql, { garminClientFactory: async () => c as never, force: true });
    expect(out.status).toBe("synced");
  });
});

describe("re-syncing replaces rather than duplicating (#602)", () => {
  it("deletes the tracked workout before creating the new one", async () => {
    const order: string[] = [];
    (garminDelete as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("delete");
    });
    const c = {
      connectapi: vi.fn(async () => []),
      post: vi.fn(async () => {
        order.push("create");
        return { workoutId: 901 };
      }),
    } as never;
    const { sql } = sqlWith([{ garmin_workout_id: "77", status: "success", content_hash: "stale" }]);

    await syncRoutine(ROUTINE, sql, { garminClientFactory: async () => c as never });

    // Delete first. The other order means a crash between the two leaves the
    // user with two workouts, which is the bug.
    expect(order).toEqual(["delete", "create"]);
  });

  it("also removes orphans left in the library by earlier syncs", async () => {
    // The state most existing users are already in: several copies on Garmin,
    // only the newest one in the database.
    const library = [
      { workoutId: 50, workoutName: "Push Day", description: `x\n${ROUTINE_DESC_MARKER}` },
      { workoutId: 51, workoutName: "Push Day", description: `x\n${ROUTINE_DESC_MARKER}` },
    ];
    const c = client(library, 902);
    const { sql } = sqlWith([{ garmin_workout_id: "77", status: "success", content_hash: "stale" }]);

    await syncRoutine(ROUTINE, sql, { garminClientFactory: async () => c as never });

    const deleted = (garminDelete as unknown as ReturnType<typeof vi.fn>).mock.calls.map((a) => String(a[1]));
    expect(deleted.some((p) => p.includes("50"))).toBe(true);
    expect(deleted.some((p) => p.includes("51"))).toBe(true);
    expect(deleted.some((p) => p.includes("77"))).toBe(true);
  });

  it("leaves a same-named workout of the user's own alone", async () => {
    const library = [{ workoutId: 60, workoutName: "Push Day", description: "my own" }];
    const c = client(library, 903);
    const { sql } = sqlWith([]);

    await syncRoutine(ROUTINE, sql, { garminClientFactory: async () => c as never });

    const deleted = (garminDelete as unknown as ReturnType<typeof vi.fn>).mock.calls.map((a) => String(a[1]));
    expect(deleted.some((p) => p.includes("60"))).toBe(false);
  });

  it("still creates when the library listing fails", async () => {
    // A listing we cannot read is "unknown". Falling back to the tracked id is
    // right; refusing to sync at all would be worse.
    const c = {
      connectapi: vi.fn(async () => {
        throw new Error("Garmin listing failed");
      }),
      post: vi.fn(async () => ({ workoutId: 904 })),
    } as never;
    const { sql } = sqlWith([]);

    const out = await syncRoutine(ROUTINE, sql, { garminClientFactory: async () => c as never });
    expect(out.status).toBe("synced");
  });
});

describe("routines deleted on Garmin stop reading as synced (#607)", () => {
  it("does NOTHING when the listing failed, rather than flagging everything", async () => {
    // The dangerous direction. Treating an unreadable listing as an empty
    // library would flip every routine on the dashboard to missing at once.
    const { sql, texts } = sqlWith([{ hevy_routine_id: "r1", garmin_workout_id: "77", status: "success" }]);
    const changed = await reconcileMissingRoutineWorkouts(sql, null);

    expect(changed).toEqual([]);
    expect(texts).toEqual([]); // not even a read
  });

  it("flags a routine whose workout is gone", async () => {
    const { sql } = sqlWith([{ hevy_routine_id: "r1", garmin_workout_id: "77", status: "success" }]);
    const changed = await reconcileMissingRoutineWorkouts(sql, []);
    expect(changed).toEqual(["r1"]);
  });

  it("unflags one that came back, which self-heals a truncated listing", async () => {
    const { sql } = sqlWith([
      { hevy_routine_id: "r1", garmin_workout_id: "77", status: "missing_on_garmin" },
    ]);
    const changed = await reconcileMissingRoutineWorkouts(sql, [
      { id: "77", name: "Push Day", description: "" },
    ]);
    expect(changed).toEqual(["r1"]);
  });

  it("leaves a present routine untouched", async () => {
    const { sql } = sqlWith([{ hevy_routine_id: "r1", garmin_workout_id: "77", status: "success" }]);
    const changed = await reconcileMissingRoutineWorkouts(sql, [
      { id: "77", name: "Push Day", description: "" },
    ]);
    expect(changed).toEqual([]);
  });
});
