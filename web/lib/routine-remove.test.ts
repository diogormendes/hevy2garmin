import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./garmin-upload", () => ({ getGarminClient: async () => ({}) }));
vi.mock("./garmin-delete", async (importOriginal) => {
  const real = await importOriginal<typeof import("./garmin-delete")>();
  return { ...real, garminDelete: vi.fn(async () => {}) };
});

import { removeRoutine } from "./garmin-routine-sync";
import { garminDelete, GarminDeleteError } from "./garmin-delete";

/** Removing a synced routine deletes its Garmin workout and its rows here (#733). */

const deleteMock = garminDelete as unknown as ReturnType<typeof vi.fn>;

function db(workoutId: string | null) {
  const texts: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    texts.push(text);
    if (/SELECT garmin_workout_id FROM synced_routines/.test(text)) {
      return Promise.resolve(workoutId === undefined ? [] : [{ garmin_workout_id: workoutId }]);
    }
    return Promise.resolve([]);
  }) as never;
  return { sql, texts };
}
const opts = { garminClientFactory: async () => ({}) as never };
const deletedRows = (texts: string[]) => texts.filter((t) => t.startsWith("DELETE FROM")).map((t) => t.split(" ")[2]);

beforeEach(() => deleteMock.mockReset());

describe("removeRoutine", () => {
  it("deletes the workout on Garmin, then the routine and its schedules here", async () => {
    const d = db("77");
    expect(await removeRoutine("r1", d.sql, opts)).toEqual({ status: "removed", error: null });
    expect(deleteMock).toHaveBeenCalledWith(expect.anything(), "/workout-service/workout/77");
    expect(deletedRows(d.texts)).toEqual(["routine_schedules", "synced_routines"]);
  });

  it("removes it here when Garmin no longer has the workout", async () => {
    deleteMock.mockRejectedValueOnce(new GarminDeleteError("/workout-service/workout/77", 404));
    const d = db("77");
    expect((await removeRoutine("r1", d.sql, opts)).status).toBe("removed");
    expect(deletedRows(d.texts)).toEqual(["routine_schedules", "synced_routines"]);
  });

  it("keeps everything when Garmin refuses for another reason", async () => {
    deleteMock.mockRejectedValueOnce(new GarminDeleteError("/workout-service/workout/77", 500));
    const d = db("77");
    const out = await removeRoutine("r1", d.sql, opts);
    expect(out.status).toBe("error");
    expect(out.error).toContain("500");
    expect(deletedRows(d.texts)).toEqual([]);
  });

  it("a routine with no Garmin workout id is removed here without calling Garmin", async () => {
    const d = db(null);
    expect((await removeRoutine("r1", d.sql, opts)).status).toBe("removed");
    expect(deleteMock).not.toHaveBeenCalled();
    expect(deletedRows(d.texts)).toEqual(["routine_schedules", "synced_routines"]);
  });
});
