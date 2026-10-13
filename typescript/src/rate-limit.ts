/**
 * Throttling and backoff for Garmin calls.
 *
 * Garmin's per-IP rate limiting is this project's most common support problem,
 * and the TypeScript engine had two bare one-second sleeps and no retry at all.
 * A rate-limit response was just an error that failed the workout, and syncing
 * a backlog issued calls as fast as the event loop allowed (#599).
 *
 * Ported from `rate_limited_call` in the `garmin_auth` package, which is what
 * `sync.py:48` and `garmin.py:20` actually use. This repo's own `ratelimit.py`
 * is a different thing, the sign-in cooldown in #609, and is dead code.
 *
 * The npm `garmin-auth` has no equivalent export, so this is written rather
 * than imported.
 */

export interface RateLimitOptions {
  /** Pause after a successful call, so a sequence of calls is spaced out. */
  delayMs?: number;
  /** Attempts in total, including the first. */
  maxAttempts?: number;
  /** Backoff base. Wait is `attempt * baseWaitMs`, linear as in Python. */
  baseWaitMs?: number;
  /**
   * Ceiling on time spent sleeping in backoff across all attempts.
   *
   * Python has no equivalent because it runs in a long-lived process. Here a
   * literal port would sleep 30 + 60 + 90 = 180s, and on a serverless request
   * with a 300s wall clock that turns "rate limited, will retry" into "function
   * timed out", which is a worse failure: the pending row is parked with no
   * error at all and reconcile has to work out what happened.
   */
  maxTotalWaitMs?: number;
  /** Injectable so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RATE_LIMIT = {
  /** `DEFAULT_CALL_DELAY` in garmin_auth. */
  delayMs: 1000,
  /** `DEFAULT_MAX_RETRIES` in garmin_auth. */
  maxAttempts: 3,
  /** `DEFAULT_BASE_WAIT` in garmin_auth, in ms. */
  baseWaitMs: 30_000,
  /** Two waits at the default base, which fits inside a 300s function. */
  maxTotalWaitMs: 90_000,
} as const;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Is this error Garmin saying "slow down"?
 *
 * There is nothing to catch by type. `garmin-auth` reports a bad status by
 * putting it in the message of a `GarminAuthenticationError`, and `uploadFit`
 * throws a plain Error with the status in its text, so matching the message is
 * what is available.
 *
 * The word-boundary check matters: an activity id can contain "429", and
 * treating that as a rate limit would spend the whole backoff budget waiting
 * for a 404 that is never going to succeed.
 */
export function isRateLimited(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/(^|\D)429(\D|$)/.test(message)) return true;
  return /too many requests|rate[- ]?limit/i.test(message);
}

/**
 * Wrap a Garmin call with pacing and rate-limit backoff.
 *
 * The delay comes AFTER a successful call rather than before it, matching
 * Python. Sleeping first would add a second of latency to the first call of
 * every sync for no benefit, since there is nothing before it to be spaced
 * from.
 */
export function createRateLimiter(options: RateLimitOptions = {}) {
  const delayMs = options.delayMs ?? DEFAULT_RATE_LIMIT.delayMs;
  const maxAttempts = options.maxAttempts ?? DEFAULT_RATE_LIMIT.maxAttempts;
  const baseWaitMs = options.baseWaitMs ?? DEFAULT_RATE_LIMIT.baseWaitMs;
  const maxTotalWaitMs = options.maxTotalWaitMs ?? DEFAULT_RATE_LIMIT.maxTotalWaitMs;
  const sleep = options.sleep ?? realSleep;

  return async function limited<T>(fn: () => Promise<T>): Promise<T> {
    let waited = 0;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await fn();
        if (delayMs > 0) await sleep(delayMs);
        return result;
      } catch (err) {
        // Only a rate limit is worth waiting on. Retrying a 404 or a 500 after
        // thirty seconds burns the budget on something that cannot succeed.
        if (!isRateLimited(err)) throw err;
        lastError = err;
        if (attempt === maxAttempts) break;

        const wait = Math.min(attempt * baseWaitMs, Math.max(0, maxTotalWaitMs - waited));
        if (wait <= 0) break;
        waited += wait;
        await sleep(wait);
      }
    }
    throw lastError;
  };
}

/** A limiter with the defaults, for callers that do not need to tune it. */
export const defaultRateLimiter = createRateLimiter();
