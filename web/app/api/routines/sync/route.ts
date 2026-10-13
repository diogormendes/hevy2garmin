import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { fetchHevyRoutines } from "@/lib/hevy-routines";
import { syncRoutine, reconcileMissingRoutineWorkouts } from "@/lib/garmin-routine-sync";
import { listGarminWorkouts } from "@/lib/garmin-workout-library";
import { getGarminClient } from "@/lib/garmin-upload";
import { getDb } from "@/lib/db";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/routines/sync  { ids?: string[] } — sync every Hevy routine (or the given ids) to
 * Garmin as planned workouts, sequentially, aggregating outcomes (port of the Python bulk
 * route; the per-routine engine is the same syncRoutine the single route uses). (#461)
 */
export async function POST(request: Request) {
  if (authEnabled()) {
    const store = await cookies();
    if (!(await verifySession(store.get(SESSION_COOKIE)?.value ?? null))) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  let ids: string[] | null = null;
  try { const t = await request.text(); if (t) { const b = JSON.parse(t) as { ids?: unknown }; if (Array.isArray(b.ids)) ids = b.ids.map(String); } } catch { return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 }); }
  let sql: ReturnType<typeof getDb>;
  try { sql = getDb(); } catch (err) { return NextResponse.json({ ok: false, error: `DB unavailable: ${err instanceof Error ? err.message : String(err)}` }, { status: 503 }); }
  let routines: Awaited<ReturnType<typeof fetchHevyRoutines>>;
  try { routines = await fetchHevyRoutines(); } catch (err) { return NextResponse.json({ ok: false, error: `Hevy routines unavailable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 }); }
  const wanted = ids ? routines.filter((r) => ids!.includes(String(r.id))) : routines;
  const results: { id: string; title: string; status: string; garminWorkoutId?: string | null; error?: string }[] = [];
  for (const r of wanted) {
    const title = String(r.title ?? "");
    try { const out = await syncRoutine(r, sql); results.push({ id: String(r.id), title, status: out.status, garminWorkoutId: out.garminWorkoutId == null ? null : String(out.garminWorkoutId), error: out.error ?? undefined }); }
    catch (err) { results.push({ id: String(r.id), title, status: "error", error: err instanceof Error ? err.message : String(err) }); }
  }
  // Ask Garmin what it still has, and flag routines whose planned workout the
  // user deleted there. `null` means the listing FAILED, and the reconcile then
  // does nothing: treating an error as "everything was deleted" would flip every
  // routine on the dashboard to missing at once (#607).
  let library: Awaited<ReturnType<typeof listGarminWorkouts>> | null = null;
  try {
    library = await listGarminWorkouts(await getGarminClient());
  } catch {
    library = null;
  }
  const reconciled = await reconcileMissingRoutineWorkouts(sql, library);

  const synced = results.filter((x) => x.status === "synced").length;
  const skipped = results.filter((x) => x.status === "skipped").length;
  const failed = results.filter((x) => x.status === "error").length;
  return NextResponse.json({
    ok: failed === 0,
    total: results.length,
    synced,
    // Unchanged routines are no longer recreated, so a run that does nothing is
    // the normal outcome rather than a sign something went wrong (#603).
    skipped,
    failed,
    reconciled,
    results,
  });
}
