/** Exercise resolution — TS port of hevy2garmin mapper.py::lookup_exercise. */
import { HEVY_TO_GARMIN, TEMPLATE_TO_GARMIN } from "./exercise-map";

export const UNKNOWN_CATEGORY = 65534;
export const UNKNOWN_SUBCATEGORY = 0;

export type CustomMappings = Record<string, [number, number]>;

/**
 * A name reduced to its alphanumeric skeleton, for the fallback below.
 *
 * `[^a-z0-9]` after lowercasing, matching `_normalize_name` at
 * `mapper.py:805` literally. That strips accented letters outright rather than
 * folding them, so "Curl à la Scott" becomes "curllascott". Verified against
 * the real Python on the same inputs; a Unicode-aware class here would quietly
 * disagree with it.
 */
export function normalizeExerciseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * The built-in table keyed by normalized name, built once.
 *
 * FIRST entry wins a collision, which is `setdefault` in `mapper.py:816`.
 */
let normalizedIndex: Record<string, [number, number]> | null = null;
function getNormalizedIndex(): Record<string, [number, number]> {
  if (normalizedIndex === null) {
    const index: Record<string, [number, number]> = {};
    for (const [name, pair] of Object.entries(HEVY_TO_GARMIN)) {
      const key = normalizeExerciseName(name);
      if (key && !(key in index)) index[key] = pair;
    }
    normalizedIndex = index;
  }
  return normalizedIndex;
}

/**
 * (category, subcategory, displayName) for a Hevy exercise.
 *
 * Resolution order, matching `lookup_exercise` at `mapper.py:822`:
 *   1. custom user mapping, keyed by the user's own exercise name
 *   2. the built-in English-name table
 *   3. the Hevy template id, which is the same in every Hevy language
 *   4. a normalized retry of the custom mappings, then the table
 *
 * The name table comes before the template id even though the template id is
 * the more precise key, and that order is load-bearing. `TEMPLATE_TO_GARMIN` is
 * GENERATED from `HEVY_TO_GARMIN` and only regenerated on demand, so between
 * regenerations it is a stale copy. With it first, every correction made to the
 * name table was silently reverted for any workout carrying a template id,
 * which is all of them from the Hevy API. Its job is to cover names the English
 * table does not have, so it belongs after it (#592).
 */
export function lookupExercise(
  hevyName: string,
  templateId?: string | null,
  custom?: CustomMappings,
): { category: number; subcategory: number; displayName: string } {
  // 1. Custom mappings take priority.
  if (custom && hevyName in custom) {
    const [c, s] = custom[hevyName];
    return { category: c, subcategory: s, displayName: hevyName };
  }
  // 2. Built-in English-name table, hand-maintained and covered by tests.
  if (hevyName in HEVY_TO_GARMIN) {
    const [c, s] = HEVY_TO_GARMIN[hevyName];
    return { category: c, subcategory: s, displayName: hevyName };
  }
  // 3. Language-independent template id (#173), for names the table lacks.
  if (templateId && templateId in TEMPLATE_TO_GARMIN) {
    const [c, s] = TEMPLATE_TO_GARMIN[templateId];
    return { category: c, subcategory: s, displayName: hevyName };
  }
  // 4. Normalized fallback: tolerates formatting drift, never fuzzy.
  //
  // Only exact alphanumeric matches collapse together, so two genuinely
  // different exercises can never collide. A letter-level typo ("Palloff" for
  // "Pallof") stays a miss on purpose: a wrong mapping puts the wrong exercise
  // on someone's Garmin activity where they may never notice it, and Unknown
  // is visible and harmless (#591).
  const norm = normalizeExerciseName(hevyName);
  if (norm) {
    if (custom) {
      for (const [name, pair] of Object.entries(custom)) {
        if (normalizeExerciseName(name) === norm) {
          return { category: pair[0], subcategory: pair[1], displayName: hevyName };
        }
      }
    }
    const pair = getNormalizedIndex()[norm];
    if (pair) return { category: pair[0], subcategory: pair[1], displayName: hevyName };
  }
  return { category: UNKNOWN_CATEGORY, subcategory: UNKNOWN_SUBCATEGORY, displayName: hevyName };
}
