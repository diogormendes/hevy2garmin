/**
 * The "resynced …" note shown after a row's date (#709).
 *
 * A resync keeps the row's original sync time, which the pages date and sort
 * by, and records when it happened in `resynced_at`. This is the text for
 * that, formatted with the page's own date format, or null when the row was
 * never resynced or the value is not a date: nothing beats "resynced —".
 */
export function resyncedLabel(
  resyncedAt: string | Date | null | undefined,
  fmtDate: (value: string) => string,
): string | null {
  if (!resyncedAt) return null;
  const d = resyncedAt instanceof Date ? resyncedAt : new Date(resyncedAt);
  if (Number.isNaN(d.getTime())) return null;
  return `resynced ${fmtDate(d.toISOString())}`;
}
