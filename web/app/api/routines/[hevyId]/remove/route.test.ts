import { describe, it, expect, vi, beforeEach } from "vitest";

const removeRoutine = vi.fn();
vi.mock("@/lib/garmin-routine-sync", () => ({
  removeRoutine: (...a: unknown[]) => removeRoutine(...a),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const authEnabled = vi.fn();
const verifySession = vi.fn();
vi.mock("@/lib/auth", () => ({
  authEnabled: (...a: unknown[]) => authEnabled(...a),
  verifySession: (...a: unknown[]) => verifySession(...a),
  SESSION_COOKIE: "h2g_session",
}));
const cookieGet = vi.fn();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (...a: unknown[]) => cookieGet(...a) }) }));

import { POST } from "./route";

const params = (id: string) => ({ params: Promise.resolve({ hevyId: id }) });
const req = () => new Request("http://h/api/routines/r1/remove", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  authEnabled.mockReturnValue(false);
  verifySession.mockReturnValue(false);
  cookieGet.mockReturnValue(undefined);
  removeRoutine.mockResolvedValue({ status: "removed", error: null });
});

describe("POST /api/routines/[id]/remove (#733)", () => {
  it("authorized (no password) → removes", async () => {
    const res = await POST(req(), params("r1"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(removeRoutine).toHaveBeenCalledWith("r1", expect.anything());
  });

  it("password set + no session → 401, and nothing is removed", async () => {
    authEnabled.mockReturnValue(true);
    const res = await POST(req(), params("r1"));
    expect(res.status).toBe(401);
    expect(removeRoutine).not.toHaveBeenCalled();
  });

  it("password set + a valid session → removes", async () => {
    authEnabled.mockReturnValue(true);
    cookieGet.mockReturnValue({ value: "tok" });
    verifySession.mockReturnValue(true);
    expect((await POST(req(), params("r1"))).status).toBe(200);
  });

  it("a failed removal → 502 with its error", async () => {
    removeRoutine.mockResolvedValue({ status: "error", error: "Garmin DELETE /workout-service/workout/77 → 500" });
    const res = await POST(req(), params("r1"));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("500");
  });
});
