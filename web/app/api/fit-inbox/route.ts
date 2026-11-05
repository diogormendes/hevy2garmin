import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { authEnabled, verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getFitInboxStatus, syncFitInbox } from "@/lib/fit-inbox";
import { postgresSyncStore } from "@/lib/sync-store";
import { recordSyncRun } from "hevy2garmin";

export const dynamic = "force-dynamic";

async function isAuthorized(request: Request): Promise<boolean> {
  if (!authEnabled()) return true;

  const authHeader = request.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match && process.env.CRON_SECRET && match[1] === process.env.CRON_SECRET) {
    return true;
  }

  try {
    const store = await cookies();
    return await verifySession(store.get(SESSION_COOKIE)?.value ?? null);
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `DB unavailable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 503 },
    );
  }

  const status = await getFitInboxStatus(sql);
  return NextResponse.json({ ok: true, status });
}

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `DB unavailable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 503 },
    );
  }

  try {
    const stats = await syncFitInbox(sql);

    // Record into sync_log if any file was processed or attempted
    if (stats.synced > 0 || stats.duplicates > 0 || stats.failed > 0 || stats.found > 0) {
      await recordSyncRun(
        postgresSyncStore(sql),
        { synced: stats.synced, skipped: stats.skipped, failed: stats.failed },
        "fit_inbox",
      ).catch(() => {});
    }

    const status = await getFitInboxStatus(sql);
    return NextResponse.json({ ok: true, stats, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
