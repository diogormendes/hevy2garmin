import { describe, it, expect, vi } from "vitest";
import {
  listGarminWorkouts,
  staleWorkoutIds,
  workoutContentHash,
} from "./garmin-workout-library";
import { ROUTINE_DESC_MARKER } from "./garmin-workout";
import type { GarminClient } from "garmin-auth";

/**
 * The pieces three routine bugs all needed and none of them had.
 *
 * Re-syncing created a second copy instead of replacing (#602), every sync
 * recreated whether anything had changed or not (#603), and a routine deleted
 * on Garmin stayed "synced" for ever because nothing asked Garmin what it still
 * had (#607).
 */

const clientReturning = (body: unknown) =>
  ({ connectapi: vi.fn(async () => body) }) as unknown as GarminClient;

const entry = (id: string, name: string, description: string) => ({ id, name, description });
const ours = `Some description\n${ROUTINE_DESC_MARKER}`;

describe("listing the library", () => {
  it("reads id, name and description off each workout", async () => {
    const client = clientReturning([
      { workoutId: 11, workoutName: "Push Day", description: ours },
    ]);
    await expect(listGarminWorkouts(client)).resolves.toEqual([
      { id: "11", name: "Push Day", description: ours },
    ]);
  });

  it("THROWS on a non-list body rather than reporting an empty library", async () => {
    // This is the whole reason the function exists in this shape. Garmin can
    // answer 200 with an error envelope, and reading that as "no workouts"
    // would tell the reconcile that the user deleted every routine they have.
    // "Unknown" and "empty" must stay different answers.
    await expect(listGarminWorkouts(clientReturning({ error: "nope" }))).rejects.toThrow(/unknown/i);
  });

  it("returns an empty list for a genuinely empty library", async () => {
    await expect(listGarminWorkouts(clientReturning([]))).resolves.toEqual([]);
  });

  it("skips entries with no id or no name rather than inventing one", async () => {
    const client = clientReturning([
      { workoutId: null, workoutName: "Push Day" },
      { workoutId: 12, workoutName: "" },
      { workoutId: 13, workoutName: "Leg Day" },
    ]);
    const out = await listGarminWorkouts(client);
    expect(out.map((w) => w.id)).toEqual(["13"]);
  });
});

describe("choosing what is ours to delete", () => {
  it("includes the id the database tracks", () => {
    expect(staleWorkoutIds([], "Push Day", "77", "success")).toEqual(["77"]);
  });

  it("also finds orphans in the library by name and marker", () => {
    // The case that matters for existing users. Every sync before #602 was
    // fixed left an untracked copy, and the database only ever remembers the
    // newest, so the older ones are invisible without this.
    const library = [entry("50", "Push Day", ours), entry("51", "Push Day", ours)];
    expect(staleWorkoutIds(library, "Push Day", "77", "success").sort()).toEqual(["50", "51", "77"]);
  });

  it("NEVER touches a workout without our marker", () => {
    // Someone else's "Push Day" is theirs. Deleting it would destroy something
    // we did not create, which is the worst outcome available here, so the
    // marker is a hard gate rather than a hint.
    const library = [entry("60", "Push Day", "my own workout")];
    expect(staleWorkoutIds(library, "Push Day", null, null)).toEqual([]);
  });

  it("leaves other routines alone", () => {
    const library = [entry("61", "Leg Day", ours)];
    expect(staleWorkoutIds(library, "Push Day", null, null)).toEqual([]);
  });

  it("does not try to delete a workout already known to be gone", () => {
    // A row marked missing_on_garmin points at a workout that no longer exists,
    // so asking Garmin to delete it spends a rate-limited call on a 404.
    expect(staleWorkoutIds([], "Push Day", "77", "missing_on_garmin")).toEqual([]);
  });
});

describe("the content hash", () => {
  it("is stable across key order, so a reordered payload is not a change", () => {
    expect(workoutContentHash({ a: 1, b: 2 })).toBe(workoutContentHash({ b: 2, a: 1 }));
  });

  it("changes when the payload changes", () => {
    expect(workoutContentHash({ sets: 3 })).not.toBe(workoutContentHash({ sets: 4 }));
  });

  it("matches Python byte for byte, so neither stack recreates the other's work", () => {
    // Python: sha256 of json.dumps(sort_keys=True, separators=(",",":"),
    // ensure_ascii=True). Pinned as a literal, because the point is agreement
    // with a different implementation rather than self-consistency.
    // Both literals came from running the real thing:
    //   .venv/bin/python -c "from hevy2garmin.routine import workout_content_hash; ..."
    expect(workoutContentHash({ workoutName: "Push Day", steps: [1, 2] })).toBe(
      "b8845b62802a74b255712072e568b9f0253ba0151717d9326ed373d19a80b86e",
    );
  });

  it("escapes non-ASCII the way Python does", () => {
    // ensure_ascii=True turns "é" into é before hashing, and JSON.stringify
    // does not. Without matching that, a routine with an accent in its name
    // hashes differently in each stack and is recreated on every sync for ever.
    expect(workoutContentHash({ n: "é" })).toBe(
      "31eacc3c7fef01d59ba7ef2e7871e71e8e6c98e94dd6b85ac9aaf00f672041c9",
    );
    expect(JSON.stringify({ n: "é" })).toBe('{"n":"é"}'); // unescaped, hence the helper
  });
});
