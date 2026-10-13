/**
 * Timezone validation for the user profile (#640).
 *
 * The stored zone is stamped into the FIT as a local timestamp, so a value that
 * is not a real IANA name does not fail loudly, it just produces no local time.
 * That looks exactly like the setting having no effect, which is how a user on
 * the r/Hevy thread described it.
 *
 * The check is the runtime's own: ask Intl to format a date in that zone and see
 * whether it objects. `Intl.supportedValuesOf("timeZone")` would be tidier but
 * it omits the many aliases (Asia/Calcutta, US/Eastern) that people legitimately
 * have, and refusing a zone the runtime accepts would be worse than the bug.
 */

/** True when the runtime recognises this as a timezone. */
export function isValidTimeZone(value: string): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * The canonical spelling to store, or null when it is not a zone.
 *
 * Intl matches case-insensitively, so `europe/athens` is valid but would be
 * stored in a spelling nothing else in the project uses. `resolvedOptions()`
 * hands back the runtime's own form, so one zone has one spelling in the
 * database.
 */
export function normaliseTimeZone(value: string): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
