/**
 * The Garmin sign-in cooldown, read as well as written.
 *
 * `/api/garmin-rate-limited` has always computed a 2h-to-24h backoff and
 * written it to `app_cache`, and nothing ever read it, blocked on it, or
 * cleared it. So `hits` climbed for ever, `seconds` walked up to the 24 hour
 * cap and stayed there, and a rate-limited user could press sign in again
 * straight away, which is exactly what deepens Garmin's own timer (#609).
 *
 * Mirrors `cooldown_remaining` and `clear_rate_limit` in `ratelimit.py:50-71`.
 * The Python module is dead code, so this is not a regression being fixed but a
 * half-built feature being finished.
 */
import type { Sql } from "./pending-store";

export const RATELIMIT_KEY = "garmin_ratelimit";

interface CooldownState {
  until?: string | null;
  hits?: number;
  seconds?: number;
}

async function readState(sql: Sql): Promise<CooldownState> {
  const rows = (await sql`
    SELECT value FROM app_cache WHERE key = ${RATELIMIT_KEY} LIMIT 1
  `.catch(() => [] as Array<{ value: unknown }>)) as Array<{ value: unknown }>;
  const v = rows[0]?.value;
  return v && typeof v === "object" ? (v as CooldownState) : {};
}

/** Seconds left before another Garmin sign-in should be attempted, or 0. */
export async function cooldownRemaining(sql: Sql): Promise<number> {
  const state = await readState(sql);
  if (!state.until) return 0;
  const until = Date.parse(state.until);
  if (Number.isNaN(until)) return 0;
  const remaining = Math.floor((until - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}

/**
 * Clear the cooldown after a sign-in works, which also resets the backoff.
 *
 * Without this `hits` only ever grows, so the next rate limit would start at
 * the 24 hour cap however long ago the last one was.
 */
export async function clearCooldown(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO app_cache (key, value, updated_at)
    VALUES (${RATELIMIT_KEY}, ${sql.json({ until: null, hits: 0, seconds: 0 })}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `.catch(() => {
    // Best effort. Failing to clear costs the user a longer next backoff, and
    // throwing here would fail a sign-in that actually succeeded.
  });
}

/**
 * Human wording for a cooldown, matching `format_cooldown` in
 * `ratelimit.py:74-81`. "about 1h 45m" rather than a raw number of seconds,
 * because the number is not the useful part to someone who has been locked out.
 */
export function formatCooldown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return mins > 0 ? `about ${hours}h ${mins}m` : `about ${hours}h`;
  return `about ${mins}m`;
}
