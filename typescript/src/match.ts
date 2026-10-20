/**
 * Match Hevy workouts to EXISTING Garmin strength activities by timestamp.
 *
 * A dedup layer for a consumer that already has both lists: a Hevy workout that
 * matches an activity Garmin already holds must not be uploaded again. Pure:
 * takes the two lists, returns the (hevyId → activityId) pairs. Reading the
 * lists and recording the match belong to the application that owns the rows.
 */

export interface HevyDt { hevyId: string; date: Date; }
export interface GarminAct { gmt: string; aid: number; } // gmt = "YYYY-MM-DD HH:MM:SS"

/** Format a Date as Garmin's naive-UTC "YYYY-MM-DD HH:MM:SS". */
function gmtStr(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

const SIX_HOURS_MS = 6 * 3600 * 1000;

/**
 * Two-pass match, faithful to the Python:
 *  1. exact GMT-string match, else scan offsets -60..+60s (first hit wins),
 *  2. else the closest Garmin activity within ±6h (Hevy local-time-as-UTC offset).
 * Returns the hevyId → garmin activity_id pairs that matched.
 */
export function matchHevyToGarmin(hevyDts: HevyDt[], garminActs: GarminAct[]): Array<{ hevyId: string; aid: number }> {
  const byTime = new Map<string, number>();
  for (const g of garminActs) byTime.set(g.gmt, g.aid);
  const acts = garminActs.map((g) => ({ ms: Date.parse(g.gmt + "Z"), aid: g.aid }));

  const out: Array<{ hevyId: string; aid: number }> = [];
  for (const { hevyId, date } of hevyDts) {
    let aid: number | undefined = byTime.get(gmtStr(date));

    if (aid === undefined) { // pass 1: ±60s, first hit scanning from -60
      for (let off = -60; off <= 60; off++) {
        const cand = byTime.get(gmtStr(new Date(date.getTime() + off * 1000)));
        if (cand !== undefined) { aid = cand; break; }
      }
    }

    if (aid === undefined) { // pass 2: closest within ±6h
      const hms = date.getTime();
      let best: { d: number; aid: number } | null = null;
      for (const a of acts) {
        const d = Math.abs(a.ms - hms);
        if (d <= SIX_HOURS_MS && (best === null || d < best.d)) best = { d, aid: a.aid };
      }
      if (best) aid = best.aid;
    }

    if (aid !== undefined) out.push({ hevyId, aid });
  }
  return out;
}

/** A match with the gap between the two starts, which decides a contested activity. */
export interface TimedMatch { hevyId: string; aid: number; deltaMs: number; }

/**
 * Keep at most one workout per Garmin activity.
 *
 * `matchHevyToGarmin`'s second pass hands an unmatched workout the closest activity within six
 * hours, and nothing removes an activity the first pass already paired, so a workout with no
 * activity of its own can take one that belongs to another (seen in practice: a workout 44 to 50
 * minutes after another one, claiming the first one's activity). Writing to the activity a claim
 * names then overwrites the real workout's data.
 *
 * The winner is the smaller gap between the starts. An exact tie goes to the lower hevyId, so a
 * re-run reaches the same answer. A match whose workout or activity cannot be timed is dropped.
 */
export function resolveExclusiveMatches(
  matches: Array<{ hevyId: string; aid: number }>,
  hevyDts: HevyDt[],
  garminActs: GarminAct[],
): { kept: TimedMatch[]; dropped: TimedMatch[] } {
  const startOf = new Map(hevyDts.map((h) => [h.hevyId, h.date.getTime()]));
  const actAt = new Map(garminActs.map((g) => [g.aid, Date.parse(g.gmt + "Z")]));
  const timed: TimedMatch[] = [];
  const dropped: TimedMatch[] = [];
  for (const m of matches) {
    const h = startOf.get(m.hevyId), a = actAt.get(m.aid);
    if (h === undefined || a === undefined || isNaN(a)) { dropped.push({ ...m, deltaMs: NaN }); continue; }
    timed.push({ ...m, deltaMs: Math.abs(a - h) });
  }
  const best = new Map<number, TimedMatch>();
  for (const m of timed) {
    const cur = best.get(m.aid);
    if (!cur || m.deltaMs < cur.deltaMs || (m.deltaMs === cur.deltaMs && m.hevyId < cur.hevyId)) best.set(m.aid, m);
  }
  const kept = [...best.values()];
  const keptIds = new Set(kept.map((m) => m.hevyId + "\u0000" + m.aid));
  for (const m of timed) if (!keptIds.has(m.hevyId + "\u0000" + m.aid)) dropped.push(m);
  return { kept, dropped };
}

/** Parse a Hevy/Garmin start into a UTC Date (naive strings treated as UTC). */
export function toUtcDate(s: string): Date | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZone = /[Z+]|[-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z";
  const d = new Date(withZone);
  return isNaN(d.getTime()) ? null : d;
}
