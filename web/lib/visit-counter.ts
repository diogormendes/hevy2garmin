/**
 * Optional visit counter and error reports.
 *
 * With COLLECTOR_URL and COLLECTOR_TOKEN both set, each page view is posted in the
 * background to {COLLECTOR_URL}/collect: the page name (COLLECTOR_PAGE, or the request
 * host), the referrer, the user agent and the client IP. It never changes the response,
 * gives up after 1.5 s, and without both variables it does nothing at all, so a fork or
 * a self-hosted copy sends nothing anywhere. The same collector can also receive the errors
 * visitors' browsers hit (clientErrorScript and forwardClientError below).
 */

/** Some collectors sit behind Cloudflare, which refuses the runtime's default user agent. */
const USER_AGENT = "estate-collector-client/1.0";
const TIMEOUT_MS = 1500;

type Env = Record<string, string | undefined>;
type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

/** A GET for an HTML page: not /_next, not /api, and not a file with an extension. */
export function isPageView(req: Request, pathname: string): boolean {
  if (req.method !== "GET") return false;
  if (!(req.headers.get("accept") ?? "").includes("text/html")) return false;
  if (pathname.startsWith("/_next") || pathname === "/api" || pathname.startsWith("/api/")) return false;
  const last = pathname.split("/").pop() ?? "";
  return !/\.[A-Za-z0-9]+$/.test(last);
}

/** The body the collector takes. */
export function visitBody(req: Request, env: Env = process.env) {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  return {
    page: env.COLLECTOR_PAGE?.trim() || host,
    ref: req.headers.get("referer") || "Unknown",
    agent: req.headers.get("user-agent") ?? "",
    ip: (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim(),
    domain: "",
  };
}

/**
 * Count this request when it is a page view and a collector is configured. Returns the
 * pending post (for tests) or null when nothing is sent. Never throws.
 */
export function countVisit(
  req: Request,
  event: WaitUntil | undefined,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> | null {
  const url = env.COLLECTOR_URL?.trim();
  const token = env.COLLECTOR_TOKEN?.trim();
  if (!url || !token) return null;
  let pathname: string;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return null;
  }
  if (!isPageView(req, pathname)) return null;
  const send = fetchImpl(`${url.replace(/\/+$/, "")}/collect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(visitBody(req, env)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(
    () => undefined,
    () => undefined,
  );
  event?.waitUntil(send);
  return send;
}

/**
 * The inline script for the root layout. It sends an uncaught error or an unhandled rejection
 * to this site's own `endpoint` with `navigator.sendBeacon`, at most 5 a page view. The route
 * there forwards it only when a collector is configured, so the token never reaches a browser.
 */
export function clientErrorScript(endpoint = "/api/client-error"): string {
  return `(function () {
  var sent = 0;
  function report(message, source) {
    if (sent >= 5 || !navigator.sendBeacon) return;
    sent++;
    try {
      navigator.sendBeacon(${JSON.stringify(endpoint)}, JSON.stringify({
        message: String(message || "unknown error").slice(0, 300),
        source: String(source || location.pathname).slice(0, 250)
      }));
    } catch (e) {}
  }
  window.addEventListener("error", function (e) {
    if (e.message) report(e.message, (e.filename || location.pathname) + ":" + (e.lineno || 0));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    report("unhandled rejection: " + ((r && r.message) || r), location.pathname);
  });
})();`;
}

/**
 * Forward one error report from the page to `{COLLECTOR_URL}/collect` as `kind: "error"`.
 * Sends nothing when no collector is configured, the body is not JSON, or the message is
 * empty. Never throws.
 */
export async function forwardClientError(
  req: Request,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = env.COLLECTOR_URL?.trim();
  const token = env.COLLECTOR_TOKEN?.trim();
  if (!url || !token) return;
  let report: { message?: unknown; source?: unknown };
  try {
    // sendBeacon posts a string as text/plain, so read text and parse it.
    report = JSON.parse(await req.text());
  } catch {
    return;
  }
  const message = String(report?.message ?? "").slice(0, 300);
  if (!message) return;
  const host = req.headers.get("host") ?? new URL(req.url).host;
  await fetchImpl(`${url.replace(/\/+$/, "")}/collect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      kind: "error",
      page: env.COLLECTOR_PAGE?.trim() || host,
      message,
      source: String(report?.source ?? "").slice(0, 250),
      agent: req.headers.get("user-agent") ?? "",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(
    () => undefined,
    () => undefined,
  );
}
