import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { WorkoutRow, type WorkoutItem } from "./workout-row";

/**
 * The row's date line (#709). A resynced row keeps its original sync date and
 * adds when it was resynced: inline after the date on a wide screen, and on a
 * line of its own on a narrow one, so the longer line wraps cleanly instead of
 * crowding the buttons beside it.
 */
const item = (over: Partial<WorkoutItem> = {}): WorkoutItem => ({
  hevy_id: "w1",
  title: "Push",
  when: "2026-10-07T10:56:00Z",
  garmin_activity_id: "4242",
  kind: "terminal",
  state: "success",
  ...over,
});
const render = (i: WorkoutItem) => renderToStaticMarkup(<WorkoutRow item={i} />);

describe("WorkoutRow: resynced", () => {
  it("shows no resynced note on a row that was never resynced", () => {
    expect(render(item())).not.toMatch(/resynced/);
    expect(render(item({ resynced_at: null }))).not.toMatch(/resynced/);
  });

  it("shows the note, keeping the original date first", () => {
    const html = render(item({ resynced_at: "2026-10-09T14:52:00Z" }));
    expect(html).toMatch(/resynced/);
    const original = new Date("2026-10-07T10:56:00Z").toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(html.indexOf(original)).toBeLessThan(html.indexOf("resynced"));
  });

  it("puts it inline on wide screens and on its own line on narrow ones", () => {
    const html = render(item({ resynced_at: "2026-10-09T14:52:00Z" }));
    expect(html).toMatch(/<span class="[^"]*\bhidden sm:inline\b[^"]*"> · <span class="whitespace-nowrap">resynced /);
    expect(html).toMatch(/<div class="[^"]*\bsm:hidden\b[^"]*"><span class="whitespace-nowrap">resynced /);
  });
});
