import { describe, it, expect, vi, beforeEach } from "vitest";

/** GET /api/candidates — returns the unsynced list; degrades gracefully. */

const listCandidates = vi.fn();
vi.mock("@/lib/sync-one", () => ({ listCandidates: (...a: unknown[]) => listCandidates(...a) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/candidates", () => {
  it("returns the candidate list", async () => {
    listCandidates.mockResolvedValue([
      { hevy_id: "a", title: "Push", start_time: "2026-08-01T10:00:00Z" },
      { hevy_id: "b", title: "Pull", start_time: null },
    ]);
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.candidates).toHaveLength(2);
    expect(json.candidates[0].hevy_id).toBe("a");
  });

  it("a Hevy error degrades to an empty list + note (200, not 500)", async () => {
    listCandidates.mockRejectedValue(new Error("No Hevy API key available"));
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.candidates).toEqual([]);
    expect(json.error).toContain("Hevy");
  });
});

/**
 * The demo has no Hevy connection, so asking Hevy is pointless and worse than
 * pointless (#634 follow-up). Its stored key is a placeholder, so every visitor
 * to the Workouts page made an outbound Hevy call that could only fail, and read
 * "Couldn't load candidates: Hevy API key invalid or expired", which says the
 * demo is broken when it is working exactly as it should.
 */
describe("GET /api/candidates in demo mode", () => {
  it("says so plainly and never asks Hevy", async () => {
    process.env.DEMO_MODE = "1";
    try {
      const res = await GET();
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.candidates).toEqual([]);
      expect(json.demo).toBe(true);
      expect(json.error).toBeUndefined();
      expect(listCandidates).not.toHaveBeenCalled();
    } finally {
      delete process.env.DEMO_MODE;
    }
  });

  it("is unchanged when DEMO_MODE is off", async () => {
    listCandidates.mockResolvedValue([{ hevy_id: "a", title: "Push", start_time: null }]);
    const res = await GET();
    const json = await res.json();
    expect(json.demo).toBeUndefined();
    expect(listCandidates).toHaveBeenCalled();
  });
});
