/**
 * HTTP against the licence endpoints.
 *
 * Small on purpose: one JSON call, one place that turns a status code into a
 * typed error, one place that normalises the base URL, and one place that
 * decides whether a failure is worth trying again. Everything above it deals in
 * errors, never in status codes.
 */

import {
  ApiError,
  NetworkError,
  RateLimitError,
  SeatLimitError,
  type SeatLimitDetail,
} from './errors.js';
import { emit, type LicenseEventListener } from './events.js';
import {
  DEFAULT_RETRY,
  backoffMs,
  delay,
  isRetryableStatus,
  parseRetryAfter,
  type RetryPolicy,
} from './retry.js';

const API_PATH = '/api/v1';

/**
 * Accept whatever anyone put in a settings file and produce one shape.
 *
 * Six places in the sibling projects spell this differently - with `/v1`, with
 * `/api/v1`, with and without a trailing slash. Normalising here means a stored
 * setting from an older version keeps working instead of turning into a 404
 * that reads like a licence problem.
 */
export function normaliseApiUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  url = url.replace(/\/api\/v1$/i, '').replace(/\/v1$/i, '');
  return `${url}${API_PATH}`;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  token?: string;
  /** Query string parameters. Undefined and null values are left out. */
  query?: Record<string, string | number | boolean | null | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Override the retry policy for one call.
   *
   * Activation passes a stricter one: it is behind a dialog the customer is
   * looking at, and a two-second delay there is worse than a message.
   */
  retry?: RetryPolicy;
}

interface ServerError {
  // The API nests everything under `error`, including the structured detail.
  // Reading `detail` from the top level looks right and silently yields
  // undefined - which turns a 409 that names the occupied seats into one that
  // says nothing.
  error?: { code?: string; message?: string; detail?: unknown };
}

export interface TransportOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retry?: RetryPolicy;
  onEvent?: LicenseEventListener;
  /** Injected in tests, so a retry does not really sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected in tests, so jitter is not random. */
  random?: () => number;
  now?: () => number;
}

/** Query parameters rendered into a path, skipping the ones with nothing to say. */
function withQuery(path: string, query: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const rendered = params.toString();
  return rendered ? `${path}?${rendered}` : path;
}

export class Transport {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultTimeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly onEvent?: LicenseEventListener;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    readonly baseUrl: string,
    fetchImpl?: typeof globalThis.fetch,
    defaultTimeoutMs = 15_000,
    options: TransportOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetchImpl ?? globalThis.fetch;
    this.defaultTimeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.retryPolicy = options.retry ?? DEFAULT_RETRY;
    this.onEvent = options.onEvent;
    this.sleep = options.sleep ?? delay;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  /**
   * One request, retried according to the policy.
   *
   * The loop is deliberately flat rather than recursive: the budget and the
   * attempt count both have to be visible in one place, or a policy change
   * quietly stops applying to one of the two exits.
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const policy = options.retry ?? this.retryPolicy;
    const started = this.now();
    const url = `${this.baseUrl}${withQuery(path, options.query)}`;

    let attempt = 0;
    for (;;) {
      attempt += 1;
      emit(this.onEvent, { type: 'request.start', path, attempt });

      let outcome: { response: Response } | { failure: unknown };
      const at = this.now();
      try {
        outcome = { response: await this.send(url, options) };
      } catch (failure) {
        outcome = { failure };
      }

      // ---- a transport failure: no answer at all -------------------------
      if ('failure' in outcome) {
        // A caller that aborted gets no retry. It asked to stop, and trying
        // again is the opposite of that - the difference between a cancelled
        // start-up check and three of them.
        const wait = options.signal?.aborted
          ? null
          : this.nextDelay(attempt, policy, null, started, null);
        if (wait === null) {
          emit(this.onEvent, {
            type: 'request.failed',
            path,
            attempts: attempt,
            status: null,
            code: 'network',
          });
          // A failure to reach the server is not a licence problem. The caller
          // falls back to the cache, which is the entire reason it exists.
          throw new NetworkError('The licence server could not be reached', outcome.failure);
        }
        emit(this.onEvent, {
          type: 'request.retry',
          path,
          attempt,
          status: null,
          delayMs: wait,
          reason: 'network',
        });
        await this.sleep(wait, options.signal);
        continue;
      }

      const { response } = outcome;

      // ---- an answer, of some kind ---------------------------------------
      if (response.ok || response.status === 204) {
        emit(this.onEvent, {
          type: 'request.ok',
          path,
          attempt,
          status: response.status,
          durationMs: this.now() - at,
        });
        return await this.readBody<T>(response);
      }

      if (isRetryableStatus(response.status)) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
        const wait = this.nextDelay(attempt, policy, response.status, started, retryAfter);
        if (wait !== null) {
          emit(this.onEvent, {
            type: 'request.retry',
            path,
            attempt,
            status: response.status,
            delayMs: wait,
            reason: retryAfter === null ? `status ${response.status}` : 'retry-after',
          });
          // The body has to be drained even when it is thrown away, or the
          // connection is not returned to the pool.
          await response.text().catch(() => '');
          await this.sleep(wait, options.signal);
          continue;
        }
      }

      throw await this.toError(response, path, attempt);
    }
  }

  private async send(url: string, options: RequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    const forward = (): void => controller.abort();
    options.signal?.addEventListener('abort', forward, { once: true });

    try {
      return await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', forward);
    }
  }

  /** How long to wait before the next attempt, or null to give up now. */
  private nextDelay(
    attempt: number,
    policy: RetryPolicy,
    status: number | null,
    startedAt: number,
    retryAfterMs: number | null,
  ): number | null {
    if (attempt > policy.attempts) return null;

    let wait: number;
    if (retryAfterMs !== null) {
      // The server asked for a specific delay. Honouring it is the difference
      // between a rate limit that lifts and one that gets tightened - but a
      // client blocked for ten minutes is worse than one that uses its cache.
      if (retryAfterMs > policy.maxRetryAfterMs) return null;
      wait = retryAfterMs;
    } else {
      wait = backoffMs(attempt, policy, this.random);
    }

    const elapsed = this.now() - startedAt;
    if (elapsed + wait > policy.budgetMs) return null;
    void status;
    return wait;
  }

  private async readBody<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null as T;
    }
  }

  private async toError(response: Response, path: string, attempt: number): Promise<ApiError> {
    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    const payload = (parsed ?? {}) as ServerError;
    const message = payload.error?.message ?? `The licence server answered ${response.status}`;
    const code = payload.error?.code ?? 'api_error';

    emit(this.onEvent, {
      type: 'request.failed',
      path,
      attempts: attempt,
      status: response.status,
      code,
    });

    if (response.status === 409 && code === 'SeatLimitReached') {
      const detail = payload.error?.detail as SeatLimitDetail | undefined;
      return new SeatLimitError(
        message,
        detail ?? { seats: { total: 0, used: 0, available: 0 }, active_seats: [] },
      );
    }

    if (response.status === 429) {
      return new RateLimitError(
        message,
        parseRetryAfter(response.headers.get('retry-after'), this.now()),
      );
    }

    return new ApiError(message, response.status, code, payload.error?.detail);
  }
}
