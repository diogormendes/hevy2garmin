/**
 * A durable backend for the engine's sync lock.
 *
 * `lock.ts` shipped in #570 with tests and a `LockBackend` seam, and nothing
 * ever called it (#604). Its own comment explains why the built-in in-process
 * backend is not enough here: on serverless each request can be a fresh
 * process, so a lock in memory looks like a lock while guaranteeing nothing.
 *
 * This is the backend it was written to accept. The lock row lives in
 * `app_cache` like the other sync bookkeeping, and the takeover rule is the
 * engine's: a lock older than `staleAfterMs` may be claimed, so one crashed run
 * cannot block every later one.
 */
import type { Sql } from "./pending-store";

const LOCK_KEY_PREFIX = "sync_lock:";

interface LockRow {
  token?: string;
  takenAt?: number;
}

/**
 * Claim the lock, or return null when someone else holds a fresh one.
 *
 * The read and the write are not one statement, so two requests arriving in the
 * same millisecond can both see a free lock. That race is survivable here and
 * worth naming rather than hiding: the lock is a courtesy that stops two runs
 * doing the same work, and `claimPending` is still the thing that makes a
 * double upload impossible. A lock is not load-bearing for correctness.
 */
export function postgresLockBackend(sql: Sql) {
  return {
    async acquire(key: string, staleAfterMs: number, now: number): Promise<string | null> {
      const rowKey = LOCK_KEY_PREFIX + key;
      const rows = (await sql`
        SELECT value FROM app_cache WHERE key = ${rowKey} LIMIT 1
      `.catch(() => [] as Array<{ value: unknown }>)) as Array<{ value: unknown }>;

      const current = (rows[0]?.value ?? null) as LockRow | null;
      const takenAt = Number(current?.takenAt ?? 0);
      const held = Boolean(current?.token);
      const stale = staleAfterMs > 0 && now - takenAt >= staleAfterMs;
      if (held && !stale) return null;

      const token = `${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
      await sql`
        INSERT INTO app_cache (key, value, updated_at)
        VALUES (${rowKey}, ${sql.json({ token, takenAt: now })}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
      return token;
    },

    /**
     * Release only if we still hold it.
     *
     * A run that was taken over as stale must not free the lock the new holder
     * is using, which is the whole reason the engine hands out a token rather
     * than a boolean.
     */
    async release(key: string, token: string): Promise<void> {
      const rowKey = LOCK_KEY_PREFIX + key;
      const rows = (await sql`
        SELECT value FROM app_cache WHERE key = ${rowKey} LIMIT 1
      `.catch(() => [] as Array<{ value: unknown }>)) as Array<{ value: unknown }>;
      const current = (rows[0]?.value ?? null) as LockRow | null;
      if (current?.token !== token) return;
      await sql`DELETE FROM app_cache WHERE key = ${rowKey}`.catch(() => {});
    },
  };
}
