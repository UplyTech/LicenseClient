/**
 * When to try a licence request again, and how long to wait first.
 *
 * A licence client is not a general HTTP client, and the difference decides
 * everything here. It makes a handful of calls, at start-up and every few
 * hours, on whatever connection the customer happens to have - a hotel wifi
 * that drops the first TLS handshake, a laptop resuming from sleep, a server
 * being restarted behind a load balancer. Every one of those is a transient
 * failure that the cache would paper over, but papering over it means the
 * customer's licence quietly stops refreshing until the offline window runs out
 * on a train.
 *
 * One retry turns most of those into nothing at all.
 *
 * The rules are deliberately narrow:
 *
 * - **Only transport failures and 5xx.** A 401 means the token is stale and the
 *   caller has a specific answer for that. A 403 or 409 is a decision. Retrying
 *   a decision is how a seat-limit dialog turns into three seat-limit dialogs.
 * - **429 is honoured, not fought.** The server's `Retry-After` wins over the
 *   computed backoff, up to a cap - a client that ignores it is the reason rate
 *   limits get tightened for everybody.
 * - **Full jitter.** Ten thousand desktop applications started at 09:00 on
 *   Monday must not retry in lockstep; without jitter the retry *is* the
 *   outage.
 * - **A budget, not just a count.** Total time is what a user experiences, and
 *   an application blocked at start-up has to come back in a bounded time or
 *   the correct behaviour is to carry on with the cache.
 */

/** How a request that failed should be treated. */
export interface RetryPolicy {
  /** Attempts after the first. `0` disables retrying entirely. */
  attempts: number;
  /** First backoff step in milliseconds. Doubles each attempt. */
  baseDelayMs: number;
  /** Upper bound for a single wait, before jitter. */
  maxDelayMs: number;
  /** Upper bound for everything, including the requests themselves. */
  budgetMs: number;
  /** Longest `Retry-After` this client will sit out rather than give up. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: Readonly<RetryPolicy> = Object.freeze({
  attempts: 2,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  budgetMs: 20_000,
  // Beyond half a minute the honest thing is to stop blocking and let the cache
  // answer. The application will check in again later anyway.
  maxRetryAfterMs: 30_000,
});

/** Retrying disabled, for a caller that wants exactly one attempt. */
export const NO_RETRY: Readonly<RetryPolicy> = Object.freeze({
  ...DEFAULT_RETRY,
  attempts: 0,
});

/**
 * Whether a status code is worth trying again.
 *
 * 408 and 425 are the server saying "too slow" and "too early", 429 is a rate
 * limit, and 5xx is the server's own fault. Nothing else: a 4xx is an answer.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Parse a `Retry-After` header. Seconds or an HTTP date, per RFC 9110.
 *
 * Returns `null` for anything unparseable rather than guessing - a wrong guess
 * either hammers a server that asked for room or blocks a user for an hour.
 * A negative or absurd value is clamped by the caller, not here, so the raw
 * intent stays visible to a test.
 */
export function parseRetryAfter(header: string | null | undefined, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * How long to wait before attempt number `attempt` (1-based).
 *
 * Exponential with full jitter: the wait is uniform in `[0, cap]` rather than
 * exactly `cap`. Sleeping the full backoff is what makes ten thousand clients
 * retry together; sleeping a uniform fraction of it spreads them out, and the
 * expected wait is half as long into the bargain.
 */
export function backoffMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const cap = Math.min(exponential, policy.maxDelayMs);
  return Math.floor(random() * cap);
}

/** Sleep, abortably. Rejects with the signal's reason if one is given. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      // Every runtime this ships to sets `reason` to an AbortError when none
      // was given, so the second half of the `??` is for a polyfilled
      // AbortController old enough not to.
      /* v8 ignore next */
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
