import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { garminGateway } from "hevy2garmin";
import { getGarminClient } from "./garmin-upload";
import { isSynced, markSynced } from "./pending-store";
import type { Sql } from "./pending-store";

const IGNORED_DIRS = new Set(["uploaded", "processed", "@eadir", ".synologyworkingdirectory"]);

export interface FitInboxFileResult {
  fileName: string;
  status: "synced" | "skipped" | "duplicate" | "failed";
  activityId?: string | null;
  error?: string;
}

export interface FitInboxStats {
  found: number;
  synced: number;
  skipped: number;
  duplicates: number;
  failed: number;
  files: FitInboxFileResult[];
}

export interface FitInboxRecentRow {
  hevy_id: string;
  title: string;
  synced_at: string | null;
  garmin_activity_id: string | null;
  status: string;
  sync_method: string;
}

export interface FitInboxStatus {
  configured: boolean;
  inboxDir: string;
  totalFilesInDir: number;
  pendingFiles: Array<{ name: string; size: number; mtimeMs: number }>;
  syncedCount: number;
  recentSynced: FitInboxRecentRow[];
}

export function isValidFitBytes(data: Uint8Array): boolean {
  if (data.byteLength < 12) return false;
  const headerSize = data[0];
  if (headerSize !== 12 && headerSize !== 14) return false;
  return (
    data[8] === 0x2e && // '.'
    data[9] === 0x46 && // 'F'
    data[10] === 0x49 && // 'I'
    data[11] === 0x54 // 'T'
  );
}

export function fitRecordId(data: Uint8Array): string {
  const digest = createHash("sha256").update(data).digest("hex").slice(0, 16);
  return `fit:${digest}`;
}

function isDuplicateError(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err).toLowerCase();
  return text.includes("409") || text.includes("duplicate");
}

export async function getFitInboxStatus(
  sql: Sql,
  options: { inboxDir?: string } = {},
): Promise<FitInboxStatus> {
  const inboxDir = (options.inboxDir ?? process.env.H2G_FIT_INBOX_DIR ?? "").trim();
  const empty: FitInboxStatus = {
    configured: Boolean(inboxDir),
    inboxDir,
    totalFilesInDir: 0,
    pendingFiles: [],
    syncedCount: 0,
    recentSynced: [],
  };
  if (!inboxDir) return empty;

  let entries;
  try {
    entries = await fs.readdir(inboxDir, { withFileTypes: true });
  } catch {
    return empty;
  }

  const fitFiles: Array<{ name: string; filePath: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".fit")) continue;
    const filePath = path.join(inboxDir, entry.name);
    try {
      const st = await fs.stat(filePath);
      fitFiles.push({ name: entry.name, filePath, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      continue;
    }
  }

  const [syncedCountRows, recentRows] = await Promise.all([
    sql`SELECT count(*)::int AS n FROM synced_workouts WHERE sync_method LIKE 'fit_inbox%'`.catch(() => [{ n: 0 }]),
    sql`
      SELECT hevy_id, title, synced_at, garmin_activity_id, COALESCE(status, 'success') AS status, COALESCE(sync_method, 'fit_inbox') AS sync_method
      FROM synced_workouts
      WHERE sync_method LIKE 'fit_inbox%'
      ORDER BY synced_at DESC
      LIMIT 20
    `.catch(() => [] as FitInboxRecentRow[]),
  ]);

  const pendingFiles: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const file of fitFiles) {
    try {
      const data = await fs.readFile(file.filePath);
      if (!isValidFitBytes(data)) continue;
      const recId = fitRecordId(data);
      if (!(await isSynced(recId, sql))) {
        pendingFiles.push({ name: file.name, size: file.size, mtimeMs: file.mtimeMs });
      }
    } catch {
      continue;
    }
  }

  return {
    configured: true,
    inboxDir,
    totalFilesInDir: fitFiles.length,
    pendingFiles,
    syncedCount: syncedCountRows[0]?.n ?? 0,
    recentSynced: recentRows.map((r) => ({
      hevy_id: r.hevy_id,
      title: r.title ?? "",
      synced_at: r.synced_at ?? null,
      garmin_activity_id: r.garmin_activity_id ?? null,
      status: r.status,
      sync_method: r.sync_method,
    })),
  };
}

export async function syncFitInbox(
  sql: Sql,
  options: { inboxDir?: string; archiveUploaded?: boolean } = {},
): Promise<FitInboxStats> {
  const stats: FitInboxStats = { found: 0, synced: 0, skipped: 0, duplicates: 0, failed: 0, files: [] };
  const inboxDir = (options.inboxDir ?? process.env.H2G_FIT_INBOX_DIR ?? "").trim();
  if (!inboxDir) return stats;

  const archiveUploaded =
    options.archiveUploaded ??
    ["1", "true", "yes"].includes((process.env.H2G_FIT_INBOX_ARCHIVE ?? "").trim().toLowerCase());

  let entries;
  try {
    entries = await fs.readdir(inboxDir, { withFileTypes: true });
  } catch (err) {
    console.error("[syncFitInbox] Cannot read inboxDir:", inboxDir, err);
    return stats;
  }

  const candidates: Array<{ filePath: string; name: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".fit")) continue;
    const filePath = path.join(inboxDir, entry.name);
    try {
      const st = await fs.stat(filePath);
      candidates.push({ filePath, name: entry.name, mtimeMs: st.mtimeMs });
    } catch {
      continue;
    }
  }

  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  if (candidates.length === 0) return stats;

  let gateway: ReturnType<typeof garminGateway> | null = null;

  for (const item of candidates) {
    let data: Buffer;
    try {
      data = await fs.readFile(item.filePath);
    } catch (err) {
      stats.failed += 1;
      stats.files.push({ fileName: item.name, status: "failed", error: String(err) });
      continue;
    }

    if (!isValidFitBytes(data)) {
      stats.skipped += 1;
      stats.files.push({ fileName: item.name, status: "skipped", error: "Not a valid FIT file" });
      continue;
    }

    const recId = fitRecordId(data);
    if (await isSynced(recId, sql)) {
      stats.skipped += 1;
      stats.files.push({ fileName: item.name, status: "skipped", error: "Already synced" });
      if (archiveUploaded) await archiveFile(item.filePath, path.join(inboxDir, "uploaded"), item.name);
      continue;
    }

    stats.found += 1;
    const title = path.parse(item.name).name;

    try {
      gateway ??= garminGateway(await getGarminClient());
      const res = await gateway.upload(new Uint8Array(data));
      const rawRes = res as unknown as { activityId?: number | string | null; activity_id?: number | string | null };
      const activityId = rawRes?.activityId != null ? String(rawRes.activityId) : (rawRes?.activity_id != null ? String(rawRes.activity_id) : null);
      await markSynced(
        recId,
        { garminActivityId: activityId, title, syncMethod: "fit_inbox" },
        sql,
      );
      stats.synced += 1;
      stats.files.push({ fileName: item.name, status: "synced", activityId });
      if (archiveUploaded) await archiveFile(item.filePath, path.join(inboxDir, "uploaded"), item.name);
    } catch (err) {
      if (isDuplicateError(err)) {
        await markSynced(
          recId,
          { garminActivityId: null, title, syncMethod: "fit_inbox_duplicate" },
          sql,
        );
        stats.duplicates += 1;
        stats.files.push({ fileName: item.name, status: "duplicate", error: "Duplicate activity on Garmin" });
        if (archiveUploaded) await archiveFile(item.filePath, path.join(inboxDir, "uploaded"), item.name);
      } else {
        stats.failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        stats.files.push({ fileName: item.name, status: "failed", error: msg });
      }
    }
  }

  return stats;
}

async function archiveFile(srcPath: string, destDir: string, fileName: string): Promise<void> {
  try {
    await fs.mkdir(destDir, { recursive: true });
    await fs.rename(srcPath, path.join(destDir, fileName));
  } catch {
    // Best-effort archive (e.g. read-only mount)
  }
}
