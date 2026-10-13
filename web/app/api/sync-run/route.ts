import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { recordSyncRun } from "hevy2garmin";
import { postgresSyncStore } from "@/lib/sync-store";
import { getDb } from "@/lib/db";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/sync-run  { synced, skipped, failed }
 *
 * Record one finished sync run in the dashboard's Sync log.
 *
 * The log had two writers, `/api/sync` and `/api/cron/sync`, and neither is
 * what the dashboard's own buttons use. Those drive `/api/sync-one` once per
 * workout, so nothing was ever recorded and the panel said "No sync runs
 * recorded yet" while workouts were plainly syncing. A user read that as proof
 * his setup was broken (#565, then #611).
 *
 * Why a separate endpoint rather than recording inside `/api/sync-one`: the
 * loop walks the backlog one workout at a time, so a row per workout would fill
 * the panel with dozens of one-line entries and make it useless. Python wrote
 * one row per pass over the list, and this is that pass's end.
 *
 * The totals come from the client because the client is what knows when the
 * run finished. A tab closed mid-run therefore records nothing, which is
 * honest: that run did not finish.
 */
export async function POST(request: Request) {
  if (authEnabled()) {
    const store = await cookies();
    if (!(await verifySession(store.get(SESSION_COOKIE)?.value ?? null))) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { synced?: unknown; skipped?: unknown; failed?: unknown; trigger?: unknown } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const count = (v: unknown) => {
    const n = Math.trunc(Number(v ?? 0));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const synced = count(body.synced);
  const skipped = count(body.skipped);
  const failed = count(body.failed);

  // A run that did nothing at all is not worth a row. It would push real runs
  // off the panel's ten-row window for no information.
  if (synced + skipped + failed === 0) {
    return NextResponse.json({ ok: true, recorded: false });
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  await recordSyncRun(postgresSyncStore(sql), { synced, skipped, failed }, "manual");
  return NextResponse.json({ ok: true, recorded: true, synced, skipped, failed });
}
