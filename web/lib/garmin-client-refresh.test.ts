import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * getGarminClient caches one client for the life of the process. A day later its DI token
 * expires and it refreshes on a 401; Garmin rotates the refresh token then, so the store has to
 * receive the new tokens, or the next process start loads a replaced refresh token and the login
 * is lost (#721). garmin-auth 0.8 saves every refresh; this runs the real GarminAuth to check the
 * web app's client gets that. Adapted from OliverKrr's test in #722.
 */

const h = vi.hoisted(() => ({
  stored: JSON.stringify({ di_token: "access-1", di_refresh_token: "refresh-1", di_client_id: "client" }),
  saves: 0,
}));

vi.mock("./db", () => {
  const tag = (async () => []) as unknown as { (): unknown; json: <T>(v: T) => T };
  tag.json = (v) => v;
  return { getDb: () => tag };
});

vi.mock("garmin-auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("garmin-auth")>();
  class DBTokenStore {
    async load() { return h.stored; }
    async save(t: string | Record<string, unknown>) { h.stored = typeof t === "string" ? t : JSON.stringify(t); h.saves++; }
    async delete() { h.stored = ""; }
  }
  return { ...real, DBTokenStore };
});

import { getGarminClient, resetGarminClient } from "./garmin-upload";

afterEach(() => {
  vi.unstubAllGlobals();
  resetGarminClient();
});

describe("getGarminClient keeps the store's tokens current", () => {
  it("saves the rotated refresh token when the cached client refreshes mid-sync", async () => {
    let api = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("diauth.garmin.com")) {
        return new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2" }), { status: 200 });
      }
      api++;
      // 1: GarminAuth's startup check; 2: a call a day later, after the access token expired.
      return new Response(api === 2 ? "" : "{}", { status: api === 2 ? 401 : 200 });
    }));

    const client = await getGarminClient("postgres://test");
    const savesAfterStartup = h.saves;

    await client.connectapi("/activitylist-service/activities/search/activities");

    expect(h.saves).toBe(savesAfterStartup + 1);
    expect(JSON.parse(h.stored)).toMatchObject({ di_token: "access-2", di_refresh_token: "refresh-2" });

    // A new process (a deploy, a restart) starts from what the store now holds.
    resetGarminClient();
    const next = await getGarminClient("postgres://test");
    expect(next.di_refresh_token).toBe("refresh-2");
  });
});
