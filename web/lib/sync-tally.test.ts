import { describe, it, expect } from "vitest";
import { tallyForLog } from "./sync-tally";

/**
 * The Sync log has been wrong three times. Twice the writer was missing; the
 * third time the tally itself would have lied, counting every status it did not
 * recognise as a success. These pin every status the engine can return.
 */

describe("a completed sync", () => {
  it("counts synced as synced", () => {
    expect(tallyForLog("synced")).toEqual({ synced: 1, skipped: 0, failed: 0 });
  });
});

describe("nothing happened, so nothing is logged", () => {
  it("records no row for none", () => {
    // Pressing Sync now with nothing pending used to write "1 synced".
    expect(tallyForLog("none")).toBeNull();
  });

  it("records no row for a dry run", () => {
    expect(tallyForLog("dry_run")).toBeNull();
  });
});

describe("did not sync this time", () => {
  it.each(["skipped", "deferred", "processing", "needs_review", "merge_pending"])(
    "counts %s as skipped, not as a success or a failure",
    (s) => {
      expect(tallyForLog(s)).toEqual({ synced: 0, skipped: 1, failed: 0 });
    },
  );
});

describe("refused by Garmin", () => {
  it.each(["error", "failed"])("counts %s as failed", (s) => {
    expect(tallyForLog(s)).toEqual({ synced: 0, skipped: 0, failed: 1 });
  });
});

describe("a status this version has never heard of", () => {
  it("is never counted as a success", () => {
    // The engine ships on its own release cycle. Understating a success is
    // recoverable; inventing one is what makes the log untrustworthy.
    const t = tallyForLog("some_future_status");
    expect(t?.synced).toBe(0);
  });

  it("handles a missing status without throwing", () => {
    expect(tallyForLog(undefined)?.synced).toBe(0);
    expect(tallyForLog(null)?.synced).toBe(0);
  });
});
