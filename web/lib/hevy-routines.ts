/**
 * Fetch the user's Hevy routines. READ-ONLY.
 *
 * A thin delegate to `HevyClient.getAllRoutines`, which is where this belongs
 * and where Python has it. It used to reach the Hevy REST API directly and so
 * inherited none of what `HevyClient.get` gives every other Hevy call (#606):
 * no retry, no pacing, a five-page cap that silently dropped anything past
 * fifty routines, a 401 surfacing as a bare status code rather than the named
 * error carrying the fix, and a later page failing returning whatever had been
 * collected so far, which made a rate-limited fragment of twelve routines
 * indistinguishable from a complete list of four.
 *
 * #629 fixed all of that in both places at once, because `web` was pinned to a
 * package version whose client had no `getAllRoutines` and delegating then
 * would have failed at runtime. The pin has moved, so the duplicate is gone.
 */
import { HevyClient } from "hevy2garmin";
import { resolveHevyKey } from "./hevy-sync";
import type { HevyRoutine } from "./garmin-workout";

export interface FetchRoutinesOptions {
  fetchImpl?: typeof fetch;
  /** Injectable so tests neither stub globals nor wait out the real backoff. */
  retryBackoffMs?: number;
  callDelayMs?: number;
}

export async function fetchHevyRoutines(
  key?: string | null,
  opts: FetchRoutinesOptions = {},
): Promise<HevyRoutine[]> {
  const apiKey = await resolveHevyKey(key);
  if (!apiKey) throw new Error("No Hevy API key available.");
  const client = new HevyClient(apiKey, undefined, {
    fetchImpl: opts.fetchImpl,
    retryBackoffMs: opts.retryBackoffMs,
    callDelayMs: opts.callDelayMs,
  });
  return (await client.getAllRoutines()) as HevyRoutine[];
}
