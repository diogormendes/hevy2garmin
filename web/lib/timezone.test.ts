import { describe, it, expect } from "vitest";
import { isValidTimeZone, normaliseTimeZone } from "./timezone";

/**
 * A mistyped timezone used to be stored and then do nothing (#640).
 *
 * `/api/settings` did `String(raw.timezone).trim()` and saved whatever arrived,
 * so `Europe/Athnes` persisted happily and the local-time stamping silently did
 * not happen. From the outside that is indistinguishable from the setting not
 * working at all, which is what a user reported as a "time zone problem".
 *
 * The runtime already knows which zones exist, so the check costs nothing.
 */

describe("a real zone is accepted", () => {
  it.each(["Europe/Athens", "Europe/Berlin", "America/New_York", "Asia/Tokyo", "UTC"])(
    "accepts %s",
    (tz) => {
      expect(isValidTimeZone(tz)).toBe(true);
      expect(normaliseTimeZone(tz)).toBe(tz);
    },
  );

  it("trims surrounding whitespace rather than rejecting it", () => {
    expect(normaliseTimeZone("  Europe/Athens  ")).toBe("Europe/Athens");
  });
});

describe("a typo is refused, not stored", () => {
  it.each(["Europe/Athnes", "Erope/Athens", "Mars/Olympus_Mons", "GMT+2", "not a zone"])(
    "refuses %s",
    (tz) => {
      expect(isValidTimeZone(tz)).toBe(false);
      expect(normaliseTimeZone(tz)).toBeNull();
    },
  );

  it("refuses the empty string rather than treating it as a zone", () => {
    // Blank has a meaning already: leave the previous UTC behaviour alone. That
    // is the caller's decision to make, not something this should call valid.
    expect(isValidTimeZone("")).toBe(false);
    expect(normaliseTimeZone("   ")).toBeNull();
  });

  it("refuses a non-string without throwing", () => {
    expect(isValidTimeZone(undefined as unknown as string)).toBe(false);
    expect(isValidTimeZone(42 as unknown as string)).toBe(false);
    expect(isValidTimeZone(null as unknown as string)).toBe(false);
  });
});

describe("case is not silently corrected", () => {
  it("refuses a wrong-case zone rather than guessing", () => {
    // Intl is case-insensitive here, but the value is written into a FIT and
    // read back by other code, so one spelling per zone is worth keeping.
    expect(normaliseTimeZone("europe/athens")).toBe("Europe/Athens");
  });
});
