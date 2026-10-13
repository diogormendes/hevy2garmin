import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { syncOneWorkout } from "@/lib/sync-one";
import { getDb } from "@/lib/db";
import { recordSyncRun } from "hevy2garmin";
import { postgresSyncStore } from "@/lib/sync-store";
import { tallyForLog } from "@/lib/sync-tally";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

// Reads live Hevy + Postgres (and, on the live path, Garmin) at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/sync-one  —  DRY-RUN BY DEFAULT.
 *
 * Runs the single-workout Hevy→Garmin upload engine (lib/sync-one). Because a
 * bad upload creates a duplicate Garmin/Strava activity — a hard user
 * constraint — this route is dry-run unless the request EXPLICITLY opts into a
 * live upload AND is authorized.
 *
 * A live upload fires only when BOTH hold:
 *   1. the request asks for it: `?live=1` (or body { live: 1 | true }); AND
 *   2. the request is authorized: a valid h2g session cookie, OR an
 *      `Authorization: Bearer <CRON_SECRET>` header matching env CRON_SECRET.
 *
 * Anything short of both runs a dry-run (never uploads). The response mirrors
 * the Python sync-one shape: { status, dryRun, wouldUpload, dedupDecision,
 * synced/skipped/remaining/deferred/error, ... }.
 */

async function isAuthorized(request: Request): Promise<boolean> {
  // CRON_SECRET via Bearer token (for scheduled/cron invocations).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization") ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1] === cronSecret) return true;
  }
  // Session cookie (a logged-in dashboard user). When auth is disabled (no
  // password / secret configured), the app has no session gate — treat as
  // authorized so a local/self-hosted deploy without a password still works.
  if (!authEnabled()) return true;
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value ?? null;
  return verifySession(cookie);
}

function wantsLive(request: Request, body: Record<string, unknown>): boolean {
  const q = new URL(request.url).searchParams.get("live");
  if (q === "1" || q === "true") return true;
  const b = body.live;
  return b === 1 || b === true || b === "1" || b === "true";
}


/**
 * One sync_log row per live sync, written HERE rather than by the button that
 * asked for it (#611, reopened after a third report on r/Hevy).
 *
 * The writer used to live in sync-loop.tsx, so only "Sync all" recorded
 * anything. "Sync now" on the dashboard and the per-workout button both synced
 * correctly and logged nothing, and an empty History panel is indistinguishable
 * from a sync that never ran. Twice the fix wired one more caller and declared
 * the feature done. A route is the one place every caller has to pass through.
 *
 * `?batch=1` opts out for sync-loop, which drives this route once per workout
 * and posts its own totals to /api/sync-run. Without it a ten-workout run would
 * write eleven rows.
 */
function isBatch(request: Request): boolean {
  const q = new URL(request.url).searchParams.get("batch");
  return q === "1" || q === "true";
}


export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const requestedLive = wantsLive(request, body);
  const authorized = requestedLive ? await isAuthorized(request) : false;

  // Live ONLY when explicitly requested AND authorized. Otherwise dry-run.
  const dryRun = !(requestedLive && authorized);

  if (requestedLive && !authorized) {
    return NextResponse.json(
      { error: "Unauthorized: a live upload requires a session or CRON_SECRET." },
      { status: 401 },
    );
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `DB unavailable: ${error}` }, { status: 503 });
  }

  try {
    const result = await syncOneWorkout(sql, { dryRun });
    if (!dryRun && !isBatch(request)) {
      // The log is an audit trail, not the job. A failure to record must never
      // turn a completed upload into an error the user sees.
      try {
        // null means nothing happened (no candidate), and a run that did
        // nothing should not appear in the log at all.
        const tally = tallyForLog((result as { status?: unknown }).status);
        if (tally) await recordSyncRun(postgresSyncStore(sql), tally, "manual (one)");
      } catch (logErr) {
        console.error("sync_log write failed:", logErr);
      }
    }
    return NextResponse.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error }, { status: 500 });
  }
}
