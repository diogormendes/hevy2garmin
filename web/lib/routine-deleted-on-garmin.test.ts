import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./garmin-upload", () => ({ getGarminClient: async () => ({}) }));
vi.mock("./garmin-delete", async (importOriginal) => {
  const real = await importOriginal<typeof import("./garmin-delete")>();
  return { ...real, garminDelete: vi.fn(async () => {}) };
});

import { syncRoutine, unscheduleRoutine, todayInZone } from "./garmin-routine-sync";
import { routineToGarminWorkout } from "./garmin-workout";
import { workoutContentHash } from "./garmin-workout-library";
import { garminDelete, GarminDeleteError } from "./garmin-delete";

/**
 * A routine whose Garmin workout was deleted in Garmin Connect could not be
 * synced again: the row still said "success" with the same content hash, so the
 * sync skipped it, and removing its schedule failed on Garmin's 404 (#729).
 * A re-created workout also lost its calendar dates, which the Python sync
 * booked again and the web port did not.
 */

const ROUTINE = { id: "r1", title: "Leg Day", exercises: [] };
const HASH = workoutContentHash(routineToGarminWorkout(ROUTINE));
const deleteMock = garminDelete as unknown as ReturnType<typeof vi.fn>;

interface Db {
  sql: never;
  texts: string[];
  values: unknown[][];
}

/** A sql tag that answers by the query's text and records every query. */
function db(answers: { routine?: unknown[]; schedules?: unknown[] }): Db {
  const texts: string[] = [];
  const values: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join("?");
    texts.push(text);
    values.push(vals);
    if (/SELECT[\s\S]*FROM synced_routines/.test(text)) return Promise.resolve(answers.routine ?? []);
    if (/SELECT schedule_id, scheduled_date FROM routine_schedules/.test(text)) return Promise.resolve(answers.schedules ?? []);
    return Promise.resolve([]);
  }) as never;
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql, texts, values };
}

const httpError = (status: number) => Object.assign(new Error(`connectapi → ${status}`), { status });

/** A Garmin client whose GET of the tracked workout answers `workoutGet`. */
function garmin(workoutGet: "present" | number, opts: { scheduleFails?: boolean } = {}) {
  let scheduleIds = 7000;
  return {
    connectapi: vi.fn(async (path: string) => {
      if (path.startsWith("/workout-service/workout/")) {
        if (workoutGet === "present") return { workoutId: 77 };
        throw httpError(workoutGet);
      }
      return []; // the library listing
    }),
    post: vi.fn(async (path: string) => {
      if (path.startsWith("/workout-service/schedule/")) {
        if (opts.scheduleFails) throw httpError(500);
        scheduleIds += 1;
        return { workoutScheduleId: scheduleIds };
      }
      return { workoutId: 950 };
    }),
  };
}

const run = (c: ReturnType<typeof garmin>, d: Db, extra = {}) =>
  syncRoutine(ROUTINE, d.sql, { garminClientFactory: async () => c as never, today: "2026-10-12", ...extra });

beforeEach(() => deleteMock.mockReset());

describe("a workout deleted in Garmin Connect (#729)", () => {
  it("is created again rather than skipped, without deleting the id Garmin no longer has", async () => {
    const c = garmin(404);
    const d = db({ routine: [{ garmin_workout_id: "77", status: "success", content_hash: HASH }] });
    const out = await run(c, d);
    expect(out).toMatchObject({ status: "synced", garminWorkoutId: 950 });
    expect(c.post).toHaveBeenCalledWith("/workout-service/workout", expect.anything());
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("is still skipped while Garmin has it", async () => {
    const c = garmin("present");
    const d = db({ routine: [{ garmin_workout_id: "77", status: "success", content_hash: HASH }] });
    expect((await run(c, d)).status).toBe("skipped");
    expect(c.post).not.toHaveBeenCalled();
  });

  it("keeps the skip when Garmin's answer is not a 404, since that says nothing about the workout", async () => {
    const c = garmin(500);
    const d = db({ routine: [{ garmin_workout_id: "77", status: "success", content_hash: HASH }] });
    expect((await run(c, d)).status).toBe("skipped");
    expect(c.post).not.toHaveBeenCalled();
  });
});

describe("a re-created workout keeps its calendar dates", () => {
  const changed = [{ garmin_workout_id: "77", status: "success", content_hash: "an older payload" }];

  it("books today-or-later dates on the new workout, replaces their old rows and drops past ones", async () => {
    const c = garmin("present");
    const d = db({
      routine: changed,
      schedules: [
        { schedule_id: "s-future", scheduled_date: "2026-10-20" },
        { schedule_id: "s-today", scheduled_date: "2026-10-12" },
        { schedule_id: "s-past", scheduled_date: "2026-10-01" },
      ],
    });
    expect((await run(c, d)).status).toBe("synced");

    const booked = c.post.mock.calls.filter(([p]) => String(p).startsWith("/workout-service/schedule/"));
    expect(booked).toEqual([
      ["/workout-service/schedule/950", { date: "2026-10-20" }],
      ["/workout-service/schedule/950", { date: "2026-10-12" }],
    ]);
    const deleted = d.texts
      .map((t, i) => (t.startsWith("DELETE FROM routine_schedules") ? d.values[i][1] : null))
      .filter(Boolean);
    expect(deleted.sort()).toEqual(["s-future", "s-past", "s-today"]);
    expect(d.texts.some((t) => t.includes("'schedule_pending'"))).toBe(false);
  });

  it("keeps a date that fails to book and marks the routine schedule_pending, so the next sync tries again", async () => {
    const c = garmin("present", { scheduleFails: true });
    const d = db({ routine: changed, schedules: [{ schedule_id: "s-future", scheduled_date: "2026-10-20" }] });
    expect((await run(c, d)).status).toBe("synced");
    expect(d.texts.some((t) => t.startsWith("DELETE FROM routine_schedules"))).toBe(false);
    expect(d.texts.some((t) => t.includes("'schedule_pending'"))).toBe(true);
  });

  it("books nothing on a first sync, which has no earlier dates", async () => {
    const c = garmin("present");
    const d = db({ routine: [], schedules: [{ schedule_id: "x", scheduled_date: "2026-10-20" }] });
    expect((await run(c, d)).status).toBe("synced");
    expect(c.post.mock.calls.some(([p]) => String(p).startsWith("/workout-service/schedule/"))).toBe(false);
  });
});

describe("removing a schedule Garmin no longer has (#729)", () => {
  it("removes the local record when Garmin answers 404", async () => {
    deleteMock.mockRejectedValueOnce(new GarminDeleteError("/workout-service/schedule/1805383534", 404));
    const d = db({});
    const out = await unscheduleRoutine("r1", "1805383534", d.sql, { garminClientFactory: async () => ({}) as never });
    expect(out).toEqual({ status: "unscheduled", error: null });
    expect(d.texts.some((t) => t.startsWith("\n      DELETE FROM routine_schedules") || t.includes("DELETE FROM routine_schedules"))).toBe(true);
  });

  it("still reports any other failure and keeps the record", async () => {
    deleteMock.mockRejectedValueOnce(new GarminDeleteError("/workout-service/schedule/1", 500));
    const d = db({});
    const out = await unscheduleRoutine("r1", "1", d.sql, { garminClientFactory: async () => ({}) as never });
    expect(out.status).toBe("error");
    expect(out.error).toContain("500");
    expect(d.texts.some((t) => t.includes("DELETE FROM routine_schedules"))).toBe(false);
  });
});

describe("todayInZone", () => {
  it("gives the date in the user's zone, and UTC without one", () => {
    const late = new Date("2026-10-12T22:30:00Z");
    expect(todayInZone("Europe/Athens", late)).toBe("2026-10-13");
    expect(todayInZone("America/New_York", late)).toBe("2026-10-12");
    expect(todayInZone(undefined, late)).toBe("2026-10-12");
    expect(todayInZone("Not/AZone", late)).toBe("2026-10-12");
  });
});
