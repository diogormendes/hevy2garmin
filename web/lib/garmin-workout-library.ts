/**
 * The Garmin workout library: list it, delete from it, and hash what we build.
 *
 * Three routine bugs needed this and none of them could be fixed without it.
 * Re-syncing created a second copy instead of replacing (#602), every sync
 * recreated whether or not anything changed (#603), and a routine the user
 * deleted on Garmin stayed "synced" for ever because nothing ever asked Garmin
 * what it still had (#607).
 *
 * Ports `list_workouts` / `delete_workout` (`garmin.py:478-506`) and
 * `workout_content_hash` (`routine.py:36-46`).
 */
import { createHash } from "node:crypto";
import type { GarminClient } from "garmin-auth";
import { ROUTINE_DESC_MARKER } from "./garmin-workout";
import { garminDelete } from "./garmin-delete";

export interface GarminLibraryWorkout {
  id: string;
  name: string;
  description: string;
}

/**
 * The user's saved Garmin workouts.
 *
 * THROWS on a body that is not a list, deliberately. Garmin can answer 200 with
 * an error envelope, and reading that as an empty library would tell the caller
 * the user has no workouts, which for #607 means flagging every synced routine
 * as deleted. "Unknown" and "empty" have to stay different answers, so every
 * caller treats a throw as "could not tell" rather than "nothing there"
 * (`garmin.py:481-486`).
 */
export async function listGarminWorkouts(
  client: GarminClient,
  limit = 999,
): Promise<GarminLibraryWorkout[]> {
  const data = await client.connectapi<unknown>(
    `/workout-service/workouts?start=1&limit=${limit}&myWorkoutsOnly=true`,
  );
  if (!Array.isArray(data)) {
    throw new Error("Garmin workout listing returned a non-list body; treating as unknown");
  }
  const out: GarminLibraryWorkout[] = [];
  for (const w of data as Array<Record<string, unknown>>) {
    const id = w?.workoutId;
    const name = w?.workoutName;
    if (id == null || typeof name !== "string" || !name) continue;
    out.push({ id: String(id), name, description: String(w?.description ?? "") });
  }
  return out;
}

/**
 * Delete a saved Garmin workout.
 *
 * Through `garminDelete` rather than the client, because garmin-auth exposes
 * GET, POST and PUT and no DELETE, and that module already replicates the
 * client's auth and 401 retry. A second mechanism here would be one more place
 * to fix when garmin-auth finally ships `client.delete()`.
 */
export async function deleteGarminWorkout(
  client: GarminClient,
  workoutId: number | string,
): Promise<void> {
  await garminDelete(client, `/workout-service/workout/${workoutId}`);
}

/**
 * Stale copies of a routine that are ours to remove.
 *
 * Two sources, deliberately. The id this database tracks covers the ordinary
 * case. The library scan by name covers orphans left by an earlier crash, a
 * database reset, or every previous sync from before #602 was fixed, which is
 * the state most existing users are already in.
 *
 * The marker is a hard gate, not a heuristic. An entry without it is one of the
 * user's OWN Garmin workouts that happens to share a name, and deleting it
 * would destroy something we did not create.
 */
export function staleWorkoutIds(
  library: GarminLibraryWorkout[],
  workoutName: string,
  trackedId: string | null,
  trackedStatus: string | null,
): string[] {
  const ids = new Set<string>();
  // A row already marked missing_on_garmin points at a workout that is gone, so
  // there is nothing to delete and asking would spend a call on a 404.
  if (trackedId && trackedStatus !== "missing_on_garmin") ids.add(String(trackedId));
  for (const entry of library) {
    if (entry.name === workoutName && entry.description.includes(ROUTINE_DESC_MARKER)) {
      ids.add(entry.id);
    }
  }
  return [...ids];
}

/**
 * Stable hash of a generated Garmin payload, for change detection.
 *
 * Hashes the PAYLOAD rather than Hevy's `updated_at`, so the hash also changes
 * when the builder changes how it emits steps. A builder fix then re-syncs
 * everything automatically instead of needing a manual force.
 *
 * `sort_keys` with the tightest separators, matching Python byte for byte so a
 * routine synced by either stack is not needlessly recreated by the other.
 */
export function workoutContentHash(payload: unknown): string {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

/** JSON with sorted keys, no spaces, and non-ASCII escaped (Python's default). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return escapeNonAscii(JSON.stringify(value) ?? "null");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${escapeNonAscii(JSON.stringify(k))}:${canonical(obj[k])}`).join(",")}}`;
}

/** Python's `ensure_ascii=True`: everything above U+007F becomes \uXXXX. */
function escapeNonAscii(s: string): string {
  return s.replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
