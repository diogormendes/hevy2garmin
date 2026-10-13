import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET } from "./route";

/**
 * The point of this route is that it cannot be quietly wrong.
 *
 * Every support conversation ends with "Sync fork and redeploy", and nothing
 * could confirm it worked. When the behaviour then does not change, "the deploy
 * never took" and "the fix is wrong" are indistinguishable from the outside
 * (#189, then #616).
 *
 * So the tests that matter are the honesty ones: the commit comes from the
 * running process, and when there is none it says so rather than guessing.
 */

const SHA = "4a23e69b1c0d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";
const saved = { ...process.env };

beforeEach(() => {
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.HEVY2GARMIN_COMMIT_SHA;
  delete process.env.VERCEL_GIT_COMMIT_REF;
  delete process.env.VERCEL_ENV;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("GET /api/version", () => {
  it("reports the commit Vercel built, and where it came from", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = SHA;
    process.env.VERCEL_GIT_COMMIT_REF = "main";
    process.env.VERCEL_ENV = "production";

    const body = await (GET() as Response).json();
    expect(body).toEqual({
      commit: SHA,
      short: "4a23e69",
      ref: "main",
      env: "production",
      source: "vercel",
    });
  });

  it("says unknown rather than inventing a commit when there is none", async () => {
    // A self-hosted deployment is not Vercel. Reporting a guess here would make
    // the endpoint worse than useless, because the whole point is telling
    // "serving something old" apart from "cannot tell".
    const body = await (GET() as Response).json();
    expect(body.commit).toBeNull();
    expect(body.short).toBeNull();
    expect(body.source).toBe("unknown");
    expect(body.env).toBe("self-hosted");
  });

  it("accepts a commit supplied off Vercel, so a self-hosted deploy can answer too", async () => {
    process.env.HEVY2GARMIN_COMMIT_SHA = SHA;
    const body = await (GET() as Response).json();
    expect(body.short).toBe("4a23e69");
    expect(body.source).toBe("env");
  });

  it("prefers Vercel's own value when both are present", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = SHA;
    process.env.HEVY2GARMIN_COMMIT_SHA = "0".repeat(40);
    const body = await (GET() as Response).json();
    expect(body.commit).toBe(SHA);
    expect(body.source).toBe("vercel");
  });

  it("never touches a database, so it answers even when nothing else does", async () => {
    // Worth pinning: the times you most want to ask what a deployment is
    // serving are the times it is broken, and #615 is a deployment where every
    // database-backed route returns 503.
    const body = await (GET() as Response).json();
    expect(Object.keys(body).sort()).toEqual(["commit", "env", "ref", "short", "source"]);
  });
});
