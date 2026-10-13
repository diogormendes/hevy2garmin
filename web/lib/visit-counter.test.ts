import { describe, it, expect, vi } from "vitest";
import { clientErrorScript, countVisit, forwardClientError, isPageView, visitBody } from "./visit-counter";

const page = (path = "/dashboard", headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://app.example${path}`, {
    method,
    headers: { accept: "text/html,application/xhtml+xml", host: "app.example", ...headers },
  });
const ENV = { COLLECTOR_URL: "https://collect.example/", COLLECTOR_TOKEN: "t0k" };

describe("isPageView", () => {
  it("is a GET for HTML that is not an asset, /_next or /api", () => {
    expect(isPageView(page(), "/dashboard")).toBe(true);
    expect(isPageView(page("/"), "/")).toBe(true);
    expect(isPageView(page("/a", {}, "POST"), "/a")).toBe(false);
    expect(isPageView(page("/a", { accept: "application/json" }), "/a")).toBe(false);
    expect(isPageView(page("/_next/data/x"), "/_next/data/x")).toBe(false);
    expect(isPageView(page("/api/sync"), "/api/sync")).toBe(false);
    expect(isPageView(page("/logo.png"), "/logo.png")).toBe(false);
    expect(isPageView(page("/apiary"), "/apiary")).toBe(true);
  });
});

describe("countVisit", () => {
  it("does nothing unless both COLLECTOR_URL and COLLECTOR_TOKEN are set", () => {
    const f = vi.fn();
    expect(countVisit(page(), undefined, {}, f)).toBeNull();
    expect(countVisit(page(), undefined, { COLLECTOR_URL: ENV.COLLECTOR_URL }, f)).toBeNull();
    expect(countVisit(page(), undefined, { COLLECTOR_TOKEN: "t" }, f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("posts the visit with the bearer token, a 1.5 s timeout, and hands it to waitUntil", async () => {
    const f = vi.fn(async () => new Response("ok"));
    const waitUntil = vi.fn();
    const req = page("/workouts", {
      referer: "https://www.reddit.com/r/Hevy",
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
    });
    await countVisit(req, { waitUntil }, { ...ENV, COLLECTOR_PAGE: "demo" }, f as unknown as typeof fetch);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://collect.example/collect");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer t0k", "User-Agent": "estate-collector-client/1.0" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      page: "demo",
      ref: "https://www.reddit.com/r/Hevy",
      agent: "Mozilla/5.0",
      ip: "203.0.113.7",
      domain: "",
    });
  });

  it("names the page after the host and the referrer Unknown when they are not given", () => {
    expect(visitBody(page("/x"), {})).toMatchObject({ page: "app.example", ref: "Unknown", ip: "" });
  });

  it("never throws or rejects when the collector is down", async () => {
    const f = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(countVisit(page(), undefined, ENV, f as unknown as typeof fetch)).resolves.toBeUndefined();
  });

  it("skips what is not a page view", () => {
    const f = vi.fn();
    expect(countVisit(page("/api/x"), undefined, ENV, f)).toBeNull();
    expect(countVisit(page("/favicon.ico"), undefined, ENV, f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("forwardClientError", () => {
  const report = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://app.example/api/client-error", {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", host: "app.example", ...headers },
      body,
    });

  it("forwards an error as kind error with the bearer token", async () => {
    const f = vi.fn(async () => new Response("ok"));
    const long = "x".repeat(400);
    await forwardClientError(
      report(JSON.stringify({ message: long, source: "/a.js:12" }), { "user-agent": "Mozilla/5.0" }),
      ENV,
      f as unknown as typeof fetch,
    );
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://collect.example/collect");
    expect(init.headers).toMatchObject({ Authorization: "Bearer t0k", "User-Agent": "estate-collector-client/1.0" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "error",
      page: "app.example",
      message: "x".repeat(300),
      source: "/a.js:12",
      agent: "Mozilla/5.0",
    });
  });

  it("sends nothing without both variables, for a body that is not JSON, or for an empty message", async () => {
    const f = vi.fn(async () => new Response("ok"));
    const fetchImpl = f as unknown as typeof fetch;
    await forwardClientError(report('{"message":"boom"}'), {}, fetchImpl);
    await forwardClientError(report('{"message":"boom"}'), { COLLECTOR_URL: ENV.COLLECTOR_URL }, fetchImpl);
    await forwardClientError(report("not json"), ENV, fetchImpl);
    await forwardClientError(report('{"message":""}'), ENV, fetchImpl);
    expect(f).not.toHaveBeenCalled();
  });

  it("never rejects when the collector is down", async () => {
    const f = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(forwardClientError(report('{"message":"boom"}'), ENV, f as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});

describe("clientErrorScript", () => {
  it("is valid JavaScript that beacons to the given endpoint", () => {
    const js = clientErrorScript("/base/api/client-error");
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain('"/base/api/client-error"');
    expect(js).toContain("sent >= 5");
  });
});
