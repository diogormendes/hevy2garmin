import { describe, it, expect, vi } from "vitest";
import { findActivityByStartTime, uploadFit } from "../src/garmin";
import type { GarminClient } from "garmin-auth";

/**
 * `findActivityByStartTime` is layer two of the never-duplicate contract: it
 * answers "does Garmin already have this workout" before anything is uploaded.
 *
 * It can fail in two directions and they are not symmetric. Answering "no" when
 * Garmin does have it produces a duplicate activity, which is untidy. Answering
 * "yes" when Garmin does not means the workout never syncs at all, and nothing
 * says so. Widening the search (#594 date range, #595 ten minutes) pushes toward
 * the second, so the activity-type filter (#593) is what keeps it safe: a wider
 * net that still only catches the right species.
 *
 * Ported from `find_activity_by_start_time` in `src/hevy2garmin/garmin.py:232`.
 */

type Act = Record<string, unknown>;

/** A client whose `connectapi` returns `acts` and records the paths it was asked for. */
function clientWith(acts: Act[]) {
  const paths: string[] = [];
  const client = {
    connectapi: async (path: string) => {
      paths.push(path);
      return acts;
    },
  } as unknown as GarminClient;
  return { client, paths };
}

const act = (id: number, startTimeGMT: string, typeKey?: string): Act => ({
  activityId: id,
  startTimeGMT,
  ...(typeKey === undefined ? {} : { activityType: { typeKey } }),
});

describe("the search is a date range, not the last ten activities (#594)", () => {
  it("finds an old workout even when newer activities fill the account", async () => {
    // The bug: `?limit=10` only ever returned the ten most recent activities, so
    // re-syncing anything older than the last ten found nothing and uploaded a
    // duplicate. Python searches the workout's own date instead.
    const newer = Array.from({ length: 10 }, (_, i) => act(900 + i, "2026-09-20 07:00:00", "strength_training"));
    const target = act(42, "2026-03-15 18:02:00", "strength_training");
    const { client } = clientWith([...newer, target]);

    expect(await findActivityByStartTime(client, "2026-03-15T18:02:00+00:00")).toBe(42);
  });

  it("asks Garmin for the workout's own day plus and minus one", async () => {
    // The ±1 day is for time-zone edges: a workout at 23:30 local can be the
    // next day in GMT, and Python widens for exactly that reason.
    const { client, paths } = clientWith([]);
    await findActivityByStartTime(client, "2026-03-15T18:02:00+00:00");

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("startDate=2026-03-14");
    expect(paths[0]).toContain("endDate=2026-03-16");
    expect(paths[0]).not.toContain("limit=10");
  });
});

describe("only strength-shaped activities can match (#593)", () => {
  it("never returns a run that happens to start at the same time", async () => {
    // The damage is not the missed match, it is what the caller does next. It
    // renames whatever this returns, so a morning run became "Push Day".
    const { client } = clientWith([act(7, "2026-03-15 18:02:00", "running")]);
    expect(await findActivityByStartTime(client, "2026-03-15T18:02:00+00:00")).toBeNull();
  });

  it("matches strength_training and other, the two Python accepts", async () => {
    const strength = clientWith([act(1, "2026-03-15 18:02:00", "strength_training")]);
    const other = clientWith([act(2, "2026-03-15 18:02:00", "other")]);

    expect(await findActivityByStartTime(strength.client, "2026-03-15T18:02:00+00:00")).toBe(1);
    expect(await findActivityByStartTime(other.client, "2026-03-15T18:02:00+00:00")).toBe(2);
  });

  it("matches an activity with no type at all, which is our own fresh upload", async () => {
    // Python's rule is "reject what is positively something else", not "accept
    // only strength". An activity Garmin has not finished classifying comes back
    // with no typeKey, and refusing it would make us upload a second copy of the
    // thing we just uploaded. The looser rule is the deliberate one.
    const missing = clientWith([act(3, "2026-03-15 18:02:00")]);
    const blank = clientWith([act(4, "2026-03-15 18:02:00", "")]);

    expect(await findActivityByStartTime(missing.client, "2026-03-15T18:02:00+00:00")).toBe(3);
    expect(await findActivityByStartTime(blank.client, "2026-03-15T18:02:00+00:00")).toBe(4);
  });
});

describe("the match window is ten minutes, as in Python (#595)", () => {
  it("matches a start seven minutes away", async () => {
    const { client } = clientWith([act(5, "2026-03-15 18:09:00", "strength_training")]);
    expect(await findActivityByStartTime(client, "2026-03-15T18:02:00+00:00")).toBe(5);
  });

  it("does not match a start twelve minutes away", async () => {
    const { client } = clientWith([act(6, "2026-03-15 18:14:00", "strength_training")]);
    expect(await findActivityByStartTime(client, "2026-03-15T18:02:00+00:00")).toBeNull();
  });
});

describe("timestamps go through the shared helper (#610)", () => {
  it("reads a naive target start as UTC, not as the machine's local time", async () => {
    // `new Date("2026-03-15T18:02:00")` is LOCAL time in JavaScript. On a machine
    // in Europe/Athens that is two hours from the Garmin side of the same
    // comparison, which the next line had already parsed as UTC.
    //
    // This test states the expectation in UTC terms and never asks the runner
    // what zone it is in, so it cannot pass by accident on a UTC CI box, which
    // is the exact way this bug stayed invisible.
    const { client } = clientWith([act(8, "2026-03-15 18:02:00", "strength_training")]);
    expect(await findActivityByStartTime(client, "2026-03-15 18:02:00")).toBe(8);
  });

  it("returns null for a start time that cannot be parsed", async () => {
    const { client } = clientWith([act(9, "2026-03-15 18:02:00", "strength_training")]);
    expect(await findActivityByStartTime(client, "not a timestamp")).toBeNull();
  });
});

describe("exclusions (#596)", () => {
  it("skips an excluded id and keeps looking", async () => {
    const { client } = clientWith([
      act(10, "2026-03-15 18:02:00", "strength_training"),
      act(11, "2026-03-15 18:03:00", "strength_training"),
    ]);
    expect(await findActivityByStartTime(client, "2026-03-15T18:02:00+00:00", [10])).toBe(11);
  });

  it("uploadFit forwards its exclusions when it resolves the new activity", async () => {
    // On a replace, the watch activity sits at the same start time as the
    // workout. Without the exclusion the resolve returns the very activity the
    // caller is about to delete, and the later call 404s on a dead id.
    //
    // Garmin returns BOTH here, watch copy first, which is what makes this a
    // real test: unexcluded it answers 555, the id about to die.
    const client = {
      domain: "garmin.com",
      di_token: "t",
      connectapi: async () => [
        act(555, "2026-03-15 18:02:00", "strength_training"),
        act(556, "2026-03-15 18:02:00", "strength_training"),
      ],
    } as unknown as GarminClient;

    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ detailedImportResult: { uploadId: 1, successes: [] } }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const out = await uploadFit(client, new Uint8Array([1]), "2026-03-15T18:02:00+00:00", [555]);
      expect(out.activityId).toBe(556);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
