"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { withBasePath } from "@/lib/base-path";

/**
 * Remove a synced routine (#733): POSTs to /api/routines/[id]/remove, which
 * deletes its planned workout on Garmin (and with it the calendar entries) and
 * the rows here. Asks first, because the Garmin side cannot be undone.
 */
export function RoutineRemove({ hevyRoutineId, title }: { hevyRoutineId: string; title: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/routines/${encodeURIComponent(hevyRoutineId)}/remove`), { method: "POST" });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy}
          title={`Remove ${title} from Garmin and this list`}
          className="rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
        >
          Remove
        </button>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-text-muted">Delete it on Garmin too?</span>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="rounded-lg bg-danger/20 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/30 disabled:opacity-50"
          >
            {busy ? "Removing…" : "Remove"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="text-xs text-text-muted underline">
            Cancel
          </button>
        </div>
      )}
      {error && (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
