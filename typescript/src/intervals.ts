/**
 * Remove a Garmin activity's copy from intervals.icu after a replace.
 *
 * When the replace strategy deletes the original watch activity from Garmin,
 * that original has usually already synced to intervals.icu. The named FIT we
 * upload in its place then arrives there as a SECOND copy, so the user is left
 * with a duplicate on a service neither stack otherwise touches. Python cleans
 * it up; TypeScript never did (#586).
 *
 * Ported from `src/hevy2garmin/intervals_icu.py`.
 *
 * Two properties are load-bearing and both are inherited deliberately.
 *
 * It is opt-in: with no credentials it does nothing and says so, so this is a
 * no-op for everyone who does not use intervals.icu.
 *
 * It never throws. The caller has just deleted a Garmin activity, and a failure
 * to tidy a third-party service must not fail a sync that already did the thing
 * the user asked for.
 *
 * The engine does NOT read the environment for this. The credentials arrive as
 * an argument, so a consumer embedding this engine supplies its own or none,
 * and tests need no environment manipulation.
 */

export interface IntervalsConfig {
  apiKey: string;
  athleteId: string;
  /** Override for tests or a self-hosted instance. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://intervals.icu";

/** Basic auth the way intervals.icu wants it: the literal user "API_KEY". */
function authHeader(apiKey: string): string {
  const raw = `API_KEY:${apiKey}`;
  const b64 =
    typeof btoa === "function"
      ? btoa(raw)
      : Buffer.from(raw, "utf8").toString("base64");
  return `Basic ${b64}`;
}

/**
 * Delete the intervals.icu activity matching a Garmin activity id.
 *
 * intervals.icu stores a Garmin activity with the plain numeric id as
 * `external_id`. A legacy `G{id}` form is matched too, because older imports
 * used it and a user with history has both shapes.
 *
 * Returns true only when something was actually deleted.
 */
export async function deleteIcuActivity(
  garminActivityId: number | string,
  workoutStart: string,
  config: IntervalsConfig,
): Promise<boolean> {
  if (!config?.apiKey || !config?.athleteId) return false;

  const start = Date.parse(
    /[TZ]|[+-]\d\d:?\d\d$/.test(workoutStart) ? workoutStart : `${workoutStart.replace(" ", "T")}Z`,
  );
  if (Number.isNaN(start)) return false;

  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const f = config.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const headers = { Authorization: authHeader(config.apiKey), Accept: "application/json" };
  const day = (offsetMs: number) => new Date(start + offsetMs).toISOString().slice(0, 10);
  // A two-hour window either side, as in Python: the activity's recorded start
  // can differ from the workout's, and a date-only search is what the API takes.
  const oldest = day(-2 * 3600_000);
  const newest = day(2 * 3600_000);

  const targets = new Set([String(garminActivityId), `G${garminActivityId}`]);

  let icuId: string | number | null = null;
  try {
    const res = await f(
      `${base}/api/v1/athlete/${config.athleteId}/activities?oldest=${oldest}&newest=${newest}`,
      { headers },
    );
    if (!res.ok) return false;
    const activities = await res.json();
    if (!Array.isArray(activities)) return false;
    for (const a of activities as Array<Record<string, unknown>>) {
      if (targets.has(String(a?.external_id))) {
        icuId = (a?.id as string | number) ?? null;
        break;
      }
    }
  } catch {
    return false;
  }
  if (icuId == null) return false;

  try {
    // Single-activity operations live under /api/v1/activity/{id}. The
    // athlete-scoped path only supports listing, and a DELETE there is a 405.
    const res = await f(`${base}/api/v1/activity/${icuId}`, { method: "DELETE", headers });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Build the hook the engine calls after it deletes a watch activity, or null
 * when intervals.icu is not configured.
 *
 * Returning null rather than a no-op function is deliberate: the engine can
 * then skip the call entirely, and a consumer can tell "not configured" from
 * "configured and found nothing".
 */
export function intervalsCleanupHook(
  config: Partial<IntervalsConfig> | null | undefined,
): ((activityId: number | string, workoutStart: string) => Promise<void>) | null {
  if (!config?.apiKey || !config?.athleteId) return null;
  const full = config as IntervalsConfig;
  return async (activityId, workoutStart) => {
    if (!workoutStart) return;
    await deleteIcuActivity(activityId, workoutStart, full);
  };
}
