"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { withBasePath } from "@/lib/base-path";
import type { FitInboxStatus, FitInboxStats } from "@/lib/fit-inbox";

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function FitInboxCard({ initialStatus }: { initialStatus?: FitInboxStatus | null }) {
  const router = useRouter();
  const [status, setStatus] = useState<FitInboxStatus | null>(initialStatus ?? null);
  const [busy, setBusy] = useState(false);
  const [lastStats, setLastStats] = useState<FitInboxStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const isConfigured = Boolean(status?.configured);
  const pendingCount = status?.pendingFiles?.length ?? 0;
  const syncedCount = status?.syncedCount ?? 0;

  async function handleSync() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/fit-inbox"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Sync failed (${res.status})`);
        return;
      }
      setLastStats(data.stats ?? null);
      if (data.status) {
        setStatus(data.status);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh() {
    try {
      const res = await fetch(withBasePath("/api/fit-inbox"), { method: "GET" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.status) {
        setStatus(data.status);
      }
    } catch {
      // Best-effort
    }
  }

  return (
    <section className="mb-8 rounded-xl border border-border bg-surface-elevated p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal/15 text-teal text-xl">
            📁
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-text">Google Drive / FIT Inbox</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  isConfigured ? "bg-success/15 text-success" : "bg-surface-active text-text-muted"
                }`}
              >
                {isConfigured ? status?.inboxDir : "Not configured"}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-text-secondary">
              Uploads weight and activity .fit files from your local sync folder directly to Garmin Connect.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={busy}
            title="Refresh status"
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50"
          >
            ↻ Refresh
          </button>
          <button
            type="button"
            onClick={handleSync}
            disabled={busy || !isConfigured}
            className="rounded-lg bg-teal px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-teal/90 disabled:opacity-50"
          >
            {busy ? "Syncing..." : "Sync FIT Files Now"}
          </button>
        </div>
      </div>

      {/* Metrics overview */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border/60 bg-surface/60 p-3">
          <div className="text-xs uppercase tracking-wide text-text-muted">Total Synced</div>
          <div className="mt-1 text-2xl font-bold text-teal">{syncedCount}</div>
        </div>
        <div className="rounded-lg border border-border/60 bg-surface/60 p-3">
          <div className="text-xs uppercase tracking-wide text-text-muted">Waiting to Sync</div>
          <div className={`mt-1 text-2xl font-bold ${pendingCount > 0 ? "text-warm" : "text-text-muted"}`}>
            {pendingCount}
          </div>
        </div>
        <div className="col-span-2 rounded-lg border border-border/60 bg-surface/60 p-3 sm:col-span-1">
          <div className="text-xs uppercase tracking-wide text-text-muted">Files in Folder</div>
          <div className="mt-1 text-2xl font-bold text-text-secondary">
            {status?.totalFilesInDir ?? 0}
          </div>
        </div>
      </div>

      {/* Error alert */}
      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Last execution stats banner */}
      {lastStats && (
        <div
          className={`mt-4 rounded-lg border p-3 text-xs ${
            lastStats.synced > 0
              ? "border-success/30 bg-success/10 text-success"
              : lastStats.failed > 0
                ? "border-danger/30 bg-danger/10 text-danger"
                : "border-border bg-surface text-text-secondary"
          }`}
        >
          <div className="font-semibold">
            {lastStats.synced > 0
              ? `✓ Uploaded ${lastStats.synced} new .fit file(s) to Garmin Connect`
              : lastStats.failed > 0
                ? `⚠ ${lastStats.failed} file(s) failed during upload`
                : "✓ All files in folder are already synced to Garmin"}
          </div>
          {lastStats.files && lastStats.files.length > 0 && (
            <ul className="mt-2 space-y-1 font-mono text-[11px]">
              {lastStats.files.map((f, idx) => (
                <li key={idx} className="flex items-center justify-between gap-2">
                  <span className="truncate">{f.fileName}</span>
                  <span
                    className={`font-sans font-medium ${
                      f.status === "synced"
                        ? "text-success"
                        : f.status === "failed"
                          ? "text-danger"
                          : "text-text-muted"
                    }`}
                  >
                    {f.status} {f.activityId ? `(#${f.activityId})` : f.error ? `(${f.error})` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Pending files list if any */}
      {pendingCount > 0 && (
        <div className="mt-4 rounded-lg border border-warm/30 bg-warm/10 p-3">
          <div className="text-xs font-semibold text-warm">
            Pending upload ({pendingCount} file{pendingCount > 1 ? "s" : ""}):
          </div>
          <ul className="mt-1.5 space-y-1 font-mono text-xs text-text-secondary">
            {status?.pendingFiles.map((p, idx) => (
              <li key={idx} className="flex items-center justify-between">
                <span className="truncate">{p.name}</span>
                <span className="text-[11px] text-text-muted">{Math.round(p.size / 1024)} KB</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Toggle details and history */}
      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setShowDetails(!showDetails)}
          className="text-xs font-medium text-teal hover:underline"
        >
          {showDetails ? "Hide Synced Files & Logs ▲" : `View Synced Files & Logs (${status?.recentSynced?.length ?? 0}) ▼`}
        </button>
      </div>

      {showDetails && (
        <div className="mt-3">
          {(!status?.recentSynced || status.recentSynced.length === 0) ? (
            <div className="rounded-lg border border-border bg-surface p-4 text-center text-xs text-text-muted">
              No files recorded as synced yet.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-surface">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left uppercase tracking-wide text-text-muted">
                    <th className="px-3 py-2 font-medium">File / Title</th>
                    <th className="px-3 py-2 font-medium">Synced At</th>
                    <th className="px-3 py-2 font-medium">Garmin Activity</th>
                    <th className="px-3 py-2 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {status.recentSynced.map((row) => (
                    <tr key={row.hevy_id}>
                      <td className="px-3 py-2 font-medium text-text truncate max-w-xs" title={row.title}>
                        {row.title || row.hevy_id}
                      </td>
                      <td className="px-3 py-2 text-text-secondary">{fmtDate(row.synced_at)}</td>
                      <td className="px-3 py-2">
                        {row.garmin_activity_id ? (
                          <a
                            href={`https://connect.garmin.com/modern/activity/${row.garmin_activity_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-teal hover:underline font-mono"
                          >
                            #{row.garmin_activity_id} ↗
                          </a>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            row.sync_method === "fit_inbox_duplicate"
                              ? "bg-warm/15 text-warm"
                              : "bg-success/15 text-success"
                          }`}
                        >
                          {row.sync_method === "fit_inbox_duplicate" ? "duplicate" : "synced"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
