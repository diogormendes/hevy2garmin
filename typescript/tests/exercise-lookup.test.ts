import { describe, it, expect } from "vitest";
import { lookupExercise, normalizeExerciseName, UNKNOWN_CATEGORY } from "../src/mapper";
import { HEVY_TO_GARMIN, TEMPLATE_TO_GARMIN } from "../src/exercise-map";

/**
 * Two differences in `lookupExercise`, ported from `mapper.py:822-868`.
 *
 * #591 Python has four resolution steps and TypeScript had three. The missing
 * one collapses a title to its alphanumeric skeleton and retries, so a name
 * differing only by punctuation, spacing or case still resolves instead of
 * landing on the Garmin activity as Unknown.
 *
 * #592 the two tables were consulted in the opposite order. Nobody is affected
 * today, the maps agree, but `TEMPLATE_TO_GARMIN` is GENERATED from
 * `HEVY_TO_GARMIN` and only regenerated on demand, so consulting it first
 * silently reverts every correction made to the name table.
 */

/** A name that is in the built-in table, whatever the table currently holds. */
const KNOWN = Object.keys(HEVY_TO_GARMIN)[0];
const KNOWN_PAIR = HEVY_TO_GARMIN[KNOWN];

describe("formatting drift still resolves (#591)", () => {
  it("matches a name that differs only by case", () => {
    const out = lookupExercise(KNOWN.toUpperCase());
    expect(out.category).toBe(KNOWN_PAIR[0]);
    expect(out.subcategory).toBe(KNOWN_PAIR[1]);
  });

  it("matches a name that differs only by spacing", () => {
    const spaced = `  ${KNOWN.split(" ").join("   ")}  `;
    expect(lookupExercise(spaced).category).toBe(KNOWN_PAIR[0]);
  });

  it("matches an en dash where the table has a hyphen", () => {
    // The example the Python docstring was written for.
    const hyphenated = Object.keys(HEVY_TO_GARMIN).find((k) => k.includes(" - "));
    if (!hyphenated) return; // table shape changed; nothing to assert
    const enDashed = hyphenated.replace(" - ", " – ");
    expect(lookupExercise(enDashed).category).toBe(HEVY_TO_GARMIN[hyphenated][0]);
  });

  it("keeps the user's own spelling as the display name", () => {
    // The mapping resolves, but the activity should still read the way the
    // user wrote it rather than snapping to the table's spelling.
    const shouty = KNOWN.toUpperCase();
    expect(lookupExercise(shouty).displayName).toBe(shouty);
  });

  it("is NOT fuzzy: a letter-level typo stays Unknown", () => {
    // Deliberate. A wrong mapping puts the wrong exercise on someone's Garmin
    // activity and they may never notice; Unknown is visible and harmless.
    expect(lookupExercise("Palloff Press").category).toBe(UNKNOWN_CATEGORY);
  });

  it("retries the custom mappings normalized too, and they still win", () => {
    const custom = { "my  BENCH press": [1, 2] as [number, number] };
    const out = lookupExercise("My Bench Press", null, custom);
    expect(out.category).toBe(1);
    expect(out.subcategory).toBe(2);
  });

  it("returns Unknown for a name with nothing alphanumeric in it", () => {
    expect(lookupExercise("---").category).toBe(UNKNOWN_CATEGORY);
  });
});

describe("normalizeExerciseName matches Python", () => {
  it("strips accented letters rather than folding them", () => {
    // `[^a-z0-9]` after lowercasing removes them outright. Verified against
    // the real `_normalize_name`: "Curl à la Scott" -> "curllascott".
    expect(normalizeExerciseName("Curl à la Scott")).toBe("curllascott");
    expect(normalizeExerciseName("ÉLÉVATION")).toBe("lvation");
  });

  it("collapses punctuation and runs of spaces", () => {
    expect(normalizeExerciseName("Bench Press – Close Grip")).toBe("benchpressclosegrip");
    expect(normalizeExerciseName("  Bench   Press  ")).toBe("benchpress");
  });
});

describe("the name table is consulted before the template map (#592)", () => {
  it("prefers the name table when the two disagree", () => {
    // The scenario the Python docstring describes: someone corrects a pair in
    // HEVY_TO_GARMIN and does not regenerate the template map, which needs the
    // Hevy API and is a deliberate on-demand step. With the old order that
    // correction reached nobody, because every workout from the Hevy API
    // carries a template id.
    const templateId = Object.keys(TEMPLATE_TO_GARMIN)[0];
    const out = lookupExercise(KNOWN, templateId);
    expect(out.category).toBe(KNOWN_PAIR[0]);
    expect(out.subcategory).toBe(KNOWN_PAIR[1]);
  });

  it("still uses the template id for a name the table does not have", () => {
    // Its real job: a non-English Hevy locale, where the title will not be in
    // the English table but the template id is the same (#173).
    const templateId = Object.keys(TEMPLATE_TO_GARMIN)[0];
    const out = lookupExercise("Développé couché en langue inconnue", templateId);
    expect(out.category).toBe(TEMPLATE_TO_GARMIN[templateId][0]);
  });

  it("custom mappings still beat both", () => {
    const templateId = Object.keys(TEMPLATE_TO_GARMIN)[0];
    const custom = { [KNOWN]: [99, 98] as [number, number] };
    const out = lookupExercise(KNOWN, templateId, custom);
    expect(out.category).toBe(99);
  });
});
