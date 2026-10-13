/**
 * The sync lock: stop two runs working the same workouts at the same time.
 *
 * Ported from `acquire_sync_lock` / `release_sync_lock` in
 * `src/hevy2garmin/syncstate.py`, keeping the behaviour that matters:
 *
 *   - taking the lock never blocks. A second run gives up immediately rather
 *     than queueing, because a queued run would do the same work twice.
 *   - a lock held longer than the timeout is taken over. Without that, one
 *     crashed run would stop every later run for good.
 *
 * What is NOT ported is the mechanism. Python uses a `threading.Lock` held in
 * module state, which works because its dashboard is one long-lived process.
 * The TypeScript path runs on serverless request handlers, where each request
 * can be a fresh process, so a lock in memory would look like a lock while
 * guaranteeing nothing. So the lock is behind `LockBackend`: the built-in
 * backend is in-process, which is right for a CLI or a daemon, and a consumer
 * whose runs span processes supplies a backend backed by its own database.
 *
 * The other difference is deliberate. Python force-releases a stale lock, which
 * can release a lock a new run has since taken. Here every holder gets a token
 * and a release only removes the lock when the token still matches, so a run
 * that wakes up after being taken over cannot cut the new holder loose.
 */

/** Python's `_SYNC_LOCK_TIMEOUT`, 5 minutes, in milliseconds. */
export const SYNC_LOCK_TIMEOUT_MS = 300_000;

/** The default lock name. One name per thing being guarded. */
export const SYNC_LOCK_KEY = "sync";

/**
 * Where a lock actually lives.
 *
 * `acquire` returns a token when the caller won the lock and null when someone
 * else holds it. `release` must ignore a token that is no longer the holder's.
 */
export interface LockBackend {
  acquire(key: string, staleAfterMs: number, now: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
}

let tokenCounter = 0;

/** A token unique to one acquisition. */
function newToken(): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  tokenCounter += 1;
  return `${Date.now().toString(36)}-${tokenCounter}-${rand}`;
}

/**
 * A lock held in this process's memory.
 *
 * Correct for a CLI run or a long-lived daemon, and worth nothing across
 * processes. A serverless consumer must pass its own durable backend.
 */
export function createMemoryLockBackend(): LockBackend {
  const held = new Map<string, { token: string; takenAt: number }>();
  return {
    async acquire(key, staleAfterMs, now) {
      const current = held.get(key);
      const stale = current != null && staleAfterMs > 0 && now - current.takenAt >= staleAfterMs;
      if (current && !stale) return null;
      const token = newToken();
      held.set(key, { token, takenAt: now });
      return token;
    },
    async release(key, token) {
      const current = held.get(key);
      if (current && current.token === token) held.delete(key);
    },
  };
}

/**
 * The backend used when a caller names none.
 *
 * Module-level on purpose, so every sync entry point in one process sees the
 * same lock. That is the same reason Python keeps its lock in module state.
 */
const processLockBackend = createMemoryLockBackend();

export interface SyncLockOptions {
  /** Which lock to take. Default `sync`. */
  key?: string;
  /** Where the lock lives. Default: this process's memory. */
  backend?: LockBackend;
  /** Take over a lock held at least this long. Default 5 minutes; 0 disables. */
  staleAfterMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/** A held lock. Releasing twice is safe and releasing a lost lock is a no-op. */
export interface SyncLockHandle {
  key: string;
  token: string;
  release(): Promise<void>;
}

/**
 * Try to take the sync lock. Returns null when another run holds it.
 *
 * Never waits. A caller that gets null should report that a sync is already
 * running, not retry in a loop.
 */
export async function acquireSyncLock(options: SyncLockOptions = {}): Promise<SyncLockHandle | null> {
  const key = options.key ?? SYNC_LOCK_KEY;
  const backend = options.backend ?? processLockBackend;
  const staleAfterMs = options.staleAfterMs ?? SYNC_LOCK_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const token = await backend.acquire(key, staleAfterMs, now());
  if (!token) return null;

  let released = false;
  return {
    key,
    token,
    async release() {
      if (released) return;
      released = true;
      await backend.release(key, token);
    },
  };
}

/** The outcome of `withSyncLock`: either the work ran, or the lock was busy. */
export type SyncLockRun<T> = { ran: true; value: T } | { ran: false; value: null };

/**
 * Run `fn` while holding the sync lock, or report that it was busy.
 *
 * The lock is released in a `finally`, so a throwing `fn` cannot leave it held
 * for the whole timeout. The error still propagates: a failed sync is the
 * caller's to handle, and swallowing it here would hide it.
 */
export async function withSyncLock<T>(
  fn: () => Promise<T>,
  options: SyncLockOptions = {},
): Promise<SyncLockRun<T>> {
  const handle = await acquireSyncLock(options);
  if (!handle) return { ran: false, value: null };
  try {
    return { ran: true, value: await fn() };
  } finally {
    await handle.release();
  }
}
