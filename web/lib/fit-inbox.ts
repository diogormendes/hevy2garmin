import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { garminGateway } from "hevy2garmin";
import { getGarminClient } from "./garmin-upload";
import { isSynced, markSynced } from "./pending-store";
import type { Sql } from "./pending-store";

const IGNORED_DIRS = new Set(["uploaded", "processed", "@eadir", ".synologyworkingdirectory"]);

export interface FitInboxStats {
  found: number;
  synced: number;
  skipped: number;
  duplicates: number;
  failed: number;
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

export async function syncFitInbox(
  sql: Sql,
  options: { inboxDir?: string; archiveUploaded?: boolean } = {},
): Promise<FitInboxStats> {
  const stats: FitInboxStats = { found: 0, synced: 0, skipped: 0, duplicates: 0, failed: 0 };
  const inboxDir = (options.inboxDir ?? process.env.H2G_FIT_INBOX_DIR ?? "").trim();
  if (!inboxDir) return stats;

  const archiveUploaded =
    options.archiveUploaded ??
    ["1", "true", "yes"].includes((process.env.H2G_FIT_INBOX_ARCHIVE ?? "").trim().toLowerCase());

  let entries;
  try {
    entries = await fs.readdir(inboxDir, { withFileTypes: true });
  } catch {
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
    } catch {
      stats.failed += 1;
      continue;
    }

    if (!isValidFitBytes(data)) {
      stats.skipped += 1;
      continue;
    }

    const recId = fitRecordId(data);
    if (await isSynced(recId, sql)) {
      stats.skipped += 1;
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
      if (archiveUploaded) await archiveFile(item.filePath, path.join(inboxDir, "uploaded"), item.name);
    } catch (err) {
      if (isDuplicateError(err)) {
        await markSynced(
          recId,
          { garminActivityId: null, title, syncMethod: "fit_inbox_duplicate" },
          sql,
        );
        stats.duplicates += 1;
        if (archiveUploaded) await archiveFile(item.filePath, path.join(inboxDir, "uploaded"), item.name);
      } else {
        stats.failed += 1;
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
