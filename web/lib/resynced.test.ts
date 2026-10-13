import { describe, it, expect } from "vitest";
import { resyncedLabel } from "./resynced";

/**
 * The "resynced …" note a row shows after its date (#709): only when the row
 * was resynced, formatted the way the row formats its own date.
 */
describe("resyncedLabel", () => {
  const fmt = (v: string) => `<${new Date(v).toISOString()}>`;

  it("says when the row was resynced, in the row's own date format", () => {
    expect(resyncedLabel("2026-10-09T14:52:00Z", fmt)).toBe("resynced <2026-10-09T14:52:00.000Z>");
  });

  it("takes the Date the database driver returns as well as a string", () => {
    expect(resyncedLabel(new Date("2026-10-09T14:52:00Z"), fmt)).toBe("resynced <2026-10-09T14:52:00.000Z>");
  });

  it("is null for a row that was never resynced", () => {
    expect(resyncedLabel(null, fmt)).toBeNull();
    expect(resyncedLabel(undefined, fmt)).toBeNull();
    expect(resyncedLabel("", fmt)).toBeNull();
  });

  it("is null for a value that is not a date, rather than 'resynced —'", () => {
    expect(resyncedLabel("not a date", fmt)).toBeNull();
  });
});
