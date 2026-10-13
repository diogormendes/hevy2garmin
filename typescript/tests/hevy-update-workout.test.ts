import { describe, it, expect } from "vitest";
import { HevyClient, HevyAuthError } from "../src/hevy";

type Call = { url: string; init: RequestInit };
const client = (responses: Array<() => Response>, calls: Call[]) => {
  let i = 0;
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses[Math.min(i++, responses.length - 1)]();
  }) as unknown as typeof fetch;
  return new HevyClient("key", undefined, { fetchImpl: f, callDelayMs: 0, retryBackoffMs: 0 });
};

describe("HevyClient.updateWorkout", () => {
  it("PUTs the body to /workouts/{id} with the key and returns Hevy's answer", async () => {
    const calls: Call[] = [];
    const body = { workout: { title: "Push", exercises: [] } };
    const out = await client([() => new Response(JSON.stringify({ workout: [{ id: "w1" }] }), { status: 200 })], calls)
      .updateWorkout("w1", body);
    expect(out).toEqual({ workout: [{ id: "w1" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.hevyapp.com/v1/workouts/w1");
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(body);
    expect((calls[0].init.headers as Record<string, string>)["api-key"]).toBe("key");
  });

  it("retries a 503 and a 429, then succeeds", async () => {
    const calls: Call[] = [];
    await client([() => new Response("", { status: 503 }), () => new Response("", { status: 429 }), () => new Response("{}", { status: 200 })], calls)
      .updateWorkout("w1", {});
    expect(calls).toHaveLength(3);
  });

  it("throws HevyAuthError on 401, without retrying", async () => {
    const calls: Call[] = [];
    await expect(client([() => new Response("", { status: 401 })], calls).updateWorkout("w1", {})).rejects.toBeInstanceOf(HevyAuthError);
    expect(calls).toHaveLength(1);
  });

  it("throws with the status on any other failure", async () => {
    await expect(client([() => new Response("bad set", { status: 400 })], []).updateWorkout("w1", {})).rejects.toThrow(/400: bad set/);
  });

  it("accepts an empty 200 body", async () => {
    expect(await client([() => new Response("", { status: 200 })], []).updateWorkout("w1", {})).toEqual({});
  });
});
