import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lookupExercise } from "../src/mapper";

/**
 * Cross-check the whole lookup against the real Python.
 *
 * The fixture is what `hevy2garmin.mapper.lookup_exercise` actually returned
 * for 125 inputs: real table names, plus each one uppercased, re-spaced, and
 * with its hyphen swapped for an en dash, plus a few that should miss.
 * Regenerate with:
 *
 *   .venv/bin/python -c "import json; from hevy2garmin.mapper import \
 *     lookup_exercise as f; ..."
 *
 * Stronger than the hand-written cases next door: those assert what I believe
 * the rules are, this asserts agreement with the implementation being ported.
 * It is committed rather than built at test time so it runs in CI too.
 */
describe("lookupExercise agrees with Python", () => {
  const py = JSON.parse(
    readFileSync(new URL("./fixtures/python-lookup.json", import.meta.url), "utf8"),
  ) as Record<string, [number, number]>;

  it("matches on every recorded case", () => {
    const mismatches: string[] = [];
    for (const [name, [pc, ps]] of Object.entries(py)) {
      const r = lookupExercise(name);
      if (r.category !== pc || r.subcategory !== ps) {
        mismatches.push(`${JSON.stringify(name)} ts=[${r.category},${r.subcategory}] py=[${pc},${ps}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("covers both hits and deliberate misses", () => {
    const values = Object.values(py);
    expect(values.some(([c]) => c !== 65534)).toBe(true);
    expect(values.some(([c]) => c === 65534)).toBe(true);
    expect(values.length).toBeGreaterThan(100);
  });
});
