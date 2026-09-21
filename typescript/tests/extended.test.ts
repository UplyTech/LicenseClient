/**
 * The behaviour added after the first release, against the same stand-in server.
 *
 * Everything here answers a question the original client could not: is this
 * build inside the licence's update window, can a customer free the seat their
 * dead laptop is holding, does a flaky connection cost a heartbeat, and does
 * anybody find out when the cache is silently discarded.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LicenseClient } from '../src/client.js';
import {
  ApiError,
  NetworkError,
  RateLimitError,
  ValidationError,
} from '../src/errors.js';
import type { LicenseEvent } from '../src/events.js';
import { FeatureIndex } from '../src/features.js';
import { NO_RETRY, backoffMs, isRetryableStatus, parseRetryAfter } from '../src/retry.js';
import { canonicalJson } from '../src/canonical-json.js';
import { sealWithNonce } from '../src/crypto.js';
import { MemoryStorage } from '../src/storage.js';
import { Transport } from '../src/transport.js';
import type { ActivationResponse, LicenseStatusResponse } from '../src/types.js';

const VECTOR_DIR = join(__dirname, '..', '..', 'shared', 'testcases');
const signatureVectors = JSON.parse(
  readFileSync(join(VECTOR_DIR, 'signature.json'), 'utf8'),
) as { publicKey: string; keyId: string };

const FINGERPRINT = '0da041751176c4024de409802c69467bd2a47366c705815dc3acc5339b1a873d';
const NOW = new Date('2026-03-01T09:00:00Z');

function statusBody(overrides: Partial<LicenseStatusResponse> = {}): LicenseStatusResponse {
  return {
    license_id: 'lic_2f8a1c',
    product: 'teampromanager',
    type: 'subscription',
    status: 'active',
    tier: 'pro',
    features: ['teams', 'tasks', 'time_tracking'],
    expires_at: '2026-12-31T23:59:59+00:00',
    seats: { total: 5, used: 1, available: 4 },
    seat_id: 42,
    grace_period_days: 7,
    offline_valid_until: '2026-03-08T09:00:00+00:00',
    next_check_after: '2026-03-01T21:00:00+00:00',
    max_version: null,
    warnings: [],
    ...overrides,
  };
}

function activationBody(overrides: Partial<ActivationResponse> = {}): ActivationResponse {
  return {
    device_access_token: 'device-token-1',
    device_refresh_token: 'refresh-token-1',
    expires_in: 86400,
    seat_id: 42,
    license: statusBody(),
    signed_license: null,
    warnings: [],
    ...overrides,
  };
}

interface Route {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

class FakeServer {
  readonly calls: { path: string; method: string; body: unknown; token?: string }[] = [];
  private routes = new Map<string, Route[]>();
  offline = false;
  /** How many transport failures to raise before answering normally. */
  failures = 0;

  on(path: string, ...responses: Route[]): void {
    this.routes.set(path, responses);
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/v1', '') + (url.search || '');

    if (this.offline) throw new TypeError('fetch failed');
    if (this.failures > 0) {
      this.failures -= 1;
      throw new TypeError('fetch failed');
    }

    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    this.calls.push({
      path,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      token: auth?.replace('Bearer ', ''),
    });

    const key = url.pathname.replace('/api/v1', '');
    const queued = this.routes.get(key);
    if (!queued || queued.length === 0) {
      return new Response(JSON.stringify({ error: { code: 'NotFound', message: 'no route' } }), {
        status: 404,
      });
    }
    const route = queued.length > 1 ? queued.shift()! : queued[0]!;
    if (route.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { 'Content-Type': 'application/json', ...route.headers },
    });
  };
}

function makeClient(server: FakeServer, overrides: Record<string, unknown> = {}): LicenseClient {
  return new LicenseClient({
    apiBaseUrl: 'https://api.example.test',
    productSlug: 'teampromanager',
    appVersion: '2.0.0',
    publicKeys: { [signatureVectors.keyId]: signatureVectors.publicKey },
    storage: new MemoryStorage(),
    device: { fingerprint: FINGERPRINT, components: { machine_id: 'a'.repeat(64) } },
    fetch: server.fetch,
    now: () => NOW,
    ...overrides,
  });
}

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
});

// -----------------------------------------------------------------------------
// The update window
// -----------------------------------------------------------------------------

describe('the update window', () => {
  it('locks a build past the licence maxVersion', async () => {
    server.on('/licenses/device/activate', {
      status: 201,
      body: activationBody({
        license: statusBody({ type: 'perpetual', expires_at: null, max_version: '1.9.0' }),
      }),
    });
    const client = makeClient(server, { appVersion: '2.0.0' });

    const result = await client.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');

    expect(result.state).toBe('LOCKED_VERSION');
    expect(result.reason).toBe('version_not_covered');
    expect(result.canRun).toBe(false);
    // And the features go with it: an application that only checked hasFeature
    // would otherwise keep working past the window it paid for.
    expect(client.hasFeature('time_tracking')).toBe(false);
    expect(client.versionCovered).toBe(false);
  });

  it('allows the exact version the licence names', async () => {
    server.on('/licenses/device/activate', {
      status: 201,
      body: activationBody({
        license: statusBody({ type: 'perpetual', expires_at: null, max_version: '2.0.0' }),
      }),
    });
    const client = makeClient(server, { appVersion: '2.0.0' });

    expect((await client.activate('k')).state).toBe('ACTIVE');
    expect(client.versionCovered).toBe(true);
  });

  it('does not compare versions as strings', async () => {
    // The whole reason semver.ts exists: '1.10.0' < '1.9.0' as text.
    server.on('/licenses/device/activate', {
      status: 201,
      body: activationBody({
        license: statusBody({ type: 'perpetual', expires_at: null, max_version: '1.9.0' }),
      }),
    });
    const client = makeClient(server, { appVersion: '1.10.0' });

    expect((await client.activate('k')).state).toBe('LOCKED_VERSION');
  });

  it('reports a revocation rather than the window when both apply', async () => {
    server.on('/licenses/device/activate', {
      status: 201,
      body: activationBody({
        license: statusBody({
          status: 'revoked',
          type: 'perpetual',
          expires_at: null,
          max_version: '1.0.0',
        }),
      }),
    });
    const client = makeClient(server, { appVersion: '9.0.0' });

    // A revoked licence showing "please upgrade" would send the customer to
    // buy an upgrade for a licence that has been taken away.
    expect((await client.activate('k')).state).toBe('LOCKED_REVOKED');
  });
});

// -----------------------------------------------------------------------------
// Retrying
// -----------------------------------------------------------------------------

describe('retrying', () => {
  it('survives a connection that drops the first attempt', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on('/licenses/device/heartbeat', { status: 200, body: statusBody() });
    const client = makeClient(server, {
      now: () => new Date('2026-03-02T09:00:00Z'),
    });
    await client.activate('k');

    server.failures = 1;
    const result = await client.heartbeat();

    expect(result.canRun).toBe(true);
  });

  it('gives up after the policy runs out, and says it was the network', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const client = makeClient(server);
    await client.activate('k');

    server.failures = 99;
    await expect(client.heartbeat()).rejects.toBeInstanceOf(NetworkError);
  });

  it('retries a 503 and then succeeds', async () => {
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls === 1) return new Response('{}', { status: 503 });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        };
      })() as unknown as typeof fetch,
      sleep: async () => undefined,
      random: () => 0.5,
    });

    await expect(transport.request('/x')).resolves.toEqual({ ok: true });
  });

  it('does not retry a decision', async () => {
    // A 409 is an answer. Retrying it turns one seat-limit dialog into three.
    let calls = 0;
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ error: { code: 'Conflict', message: 'no' } }),
          { status: 409 },
        );
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    await expect(transport.request('/x')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });

  it('honours Retry-After rather than its own backoff', async () => {
    const slept: number[] = [];
    let calls = 0;
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response('{}', { status: 429, headers: { 'Retry-After': '2' } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        slept.push(ms);
      },
      random: () => 0.5,
    });

    await expect(transport.request('/x')).resolves.toEqual({ ok: true });
    expect(slept).toEqual([2_000]);
  });

  it('gives up rather than sitting out an absurd Retry-After', async () => {
    // A client blocked for an hour is worse than one that uses its cache.
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: 'RateLimited', message: 'slow down' } }), {
          status: 429,
          headers: { 'Retry-After': '3600' },
        })) as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    const error = await transport.request('/x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(3_600_000);
  });

  it('stops when the budget runs out even with attempts left', async () => {
    let clock = 0;
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async () => {
        clock += 30_000; // every attempt eats more than the whole budget
        return new Response('{}', { status: 503 });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      now: () => clock,
      random: () => 0.5,
    });

    await expect(transport.request('/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('does not retry behind an activation dialog', async () => {
    let calls = 0;
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async () => {
        calls += 1;
        return new Response('{}', { status: 503 });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    await expect(transport.request('/x', { retry: NO_RETRY })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });

  describe('the policy itself', () => {
    it('treats only transient statuses as retryable', () => {
      for (const status of [408, 425, 429, 500, 502, 503, 504]) {
        expect(isRetryableStatus(status), `${status} should retry`).toBe(true);
      }
      for (const status of [200, 201, 204, 400, 401, 403, 404, 409, 422]) {
        expect(isRetryableStatus(status), `${status} should not retry`).toBe(false);
      }
    });

    it('reads Retry-After as seconds and as a date', () => {
      const now = Date.parse('2026-03-01T09:00:00Z');
      expect(parseRetryAfter('5', now)).toBe(5_000);
      expect(parseRetryAfter('Sun, 01 Mar 2026 09:00:30 GMT', now)).toBe(30_000);
      // A date already past means "now", not a negative wait.
      expect(parseRetryAfter('Sun, 01 Mar 2026 08:59:00 GMT', now)).toBe(0);
      expect(parseRetryAfter('soon', now)).toBeNull();
      expect(parseRetryAfter('', now)).toBeNull();
      expect(parseRetryAfter(null, now)).toBeNull();
    });

    it('spreads retries out rather than lining them up', () => {
      const policy = { ...NO_RETRY, attempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 };
      // Full jitter: the wait is uniform in [0, cap), so the same attempt gives
      // different answers - which is the entire point of it.
      expect(backoffMs(1, policy, () => 0)).toBe(0);
      expect(backoffMs(1, policy, () => 0.999)).toBe(99);
      expect(backoffMs(2, policy, () => 0.5)).toBe(100);
      expect(backoffMs(3, policy, () => 1)).toBe(400);
      // And the cap holds however far the exponent runs.
      expect(backoffMs(20, policy, () => 1)).toBe(1_000);
    });
  });
});

// -----------------------------------------------------------------------------
// Seats and owner-facing calls
// -----------------------------------------------------------------------------

describe('seats, from the owner side', () => {
  it('lists the machines holding one', async () => {
    server.on('/licenses/lic_2f8a1c/seats', {
      status: 200,
      body: [
        {
          id: 42,
          device_name: 'work-laptop',
          platform: 'darwin',
          app_version: '2.0.0',
          status: 'active',
          last_seen_at: '2026-03-01T08:00:00+00:00',
          activated_at: '2026-01-01T08:00:00+00:00',
        },
      ],
    });
    const client = makeClient(server);

    const seats = await client.listSeats('user-token', 'lic_2f8a1c');

    expect(seats).toHaveLength(1);
    expect(seats[0]!.device_name).toBe('work-laptop');
    expect(server.calls[0]!.token).toBe('user-token');
  });

  it('frees one', async () => {
    server.on('/licenses/lic_2f8a1c/seats/42', { status: 204 });
    const client = makeClient(server);

    await client.releaseSeat('user-token', 'lic_2f8a1c', 42);

    expect(server.calls[0]!.method).toBe('DELETE');
    expect(server.calls[0]!.path).toBe('/licenses/lic_2f8a1c/seats/42');
  });

  it('escapes a licence id rather than pasting it into a path', async () => {
    server.on('/licenses/a%2Fb/seats', { status: 200, body: [] });
    const client = makeClient(server);

    await client.listSeats('t', 'a/b');

    // Without encoding this would address /licenses/a/b/seats, which is a
    // different endpoint, and on a DELETE that matters rather more.
    expect(server.calls[0]!.path).toBe('/licenses/a%2Fb/seats');
  });

  it('turns a seat limit into something a dialog can use', async () => {
    // Both answers on one route: the 409 first, then the activation that
    // succeeds once a seat has been freed. Queued rather than registered twice,
    // because a second `on` for the same path replaces the first.
    server.on(
      '/licenses/device/activate',
      {
        status: 409,
        body: {
          error: {
            code: 'SeatLimitReached',
            message: 'every seat is taken',
            detail: {
              seats: { total: 2, used: 2, available: 0 },
              active_seats: [
                {
                  id: 7,
                  device_name: 'old-laptop',
                  platform: 'win32',
                  app_version: '1.0.0',
                  status: 'active',
                  last_seen_at: '2025-11-01T08:00:00+00:00',
                  activated_at: '2025-01-01T08:00:00+00:00',
                },
              ],
            },
          },
        },
      },
      { status: 201, body: activationBody() },
    );
    server.on('/licenses/lic_2f8a1c/seats/7', { status: 204 });
    const client = makeClient(server);

    // The whole point of the pair: the error names the machine, and there is
    // now a method that frees it.
    const error = await client.activate('k').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const seats = (error as { seats: { active_seats: { id: number }[] } }).seats;
    await client.releaseSeat('user-token', 'lic_2f8a1c', seats.active_seats[0]!.id);

    expect(server.calls.at(-1)!.path).toBe('/licenses/lic_2f8a1c/seats/7');
  });
});

describe('the owner s own licences', () => {
  it('lists them with paging', async () => {
    server.on('/licenses', {
      status: 200,
      body: { items: [], total: 0, page: 2, page_size: 50 },
    });
    const client = makeClient(server);

    const page = await client.listLicenses('user-token', 2, 50);

    expect(page.page).toBe(2);
    expect(server.calls[0]!.path).toBe('/licenses?page=2&page_size=50');
  });

  it('reveals a key and keeps no copy of it', async () => {
    server.on('/licenses/lic_2f8a1c/key', {
      status: 200,
      body: { license_key: 'ULT-TPM-3F7K9-2QW8M-XZ4RB-W' },
    });
    const events: LicenseEvent[] = [];
    const storage = new MemoryStorage();
    const client = makeClient(server, { storage, onEvent: (e: LicenseEvent) => events.push(e) });

    const key = await client.revealKey('user-token', 'lic_2f8a1c');

    expect(key).toBe('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');
    // Never written to the sealed file, never put into an event. A key that
    // leaks into a log is a key that has to be reissued.
    expect(await storage.read()).toBeNull();
    expect(JSON.stringify(events)).not.toContain('3F7K9');
  });
});

// -----------------------------------------------------------------------------
// Entitlement, for bots
// -----------------------------------------------------------------------------

describe('entitlement lookup', () => {
  it('answers for a licensed subject', async () => {
    server.on('/licenses/verify', {
      status: 200,
      body: {
        licensed: true,
        tier: 'pro',
        features: ['filters'],
        license_id: 'lic_1',
        expires_at: null,
        subject: { type: 'discord_guild', ref: '123' },
      },
    });
    const client = makeClient(server);

    const answer = await client.verifySubject('api-key', {
      type: 'discord_guild',
      ref: '123',
    });

    expect(answer.licensed).toBe(true);
    expect(answer.features).toEqual(['filters']);
    expect(server.calls[0]!.path).toBe(
      '/licenses/verify?product_slug=teampromanager&subject_type=discord_guild&subject_ref=123',
    );
  });

  it('answers for an unlicensed one too, with the free tier', async () => {
    // A 200 rather than a 404, so a freemium product has one code path.
    server.on('/licenses/verify', {
      status: 200,
      body: {
        licensed: false,
        tier: 'free',
        features: ['basic'],
        license_id: null,
        expires_at: null,
        subject: { type: 'discord_guild', ref: '999' },
      },
    });
    const client = makeClient(server);

    const answer = await client.verifySubject('api-key', {
      type: 'discord_guild',
      ref: '999',
    });

    expect(answer.licensed).toBe(false);
    expect(answer.tier).toBe('free');
    expect(answer.features).toEqual(['basic']);
  });

  it('asks about a hundred guilds in one round trip', async () => {
    const refs = Array.from({ length: 100 }, (_, index) => String(index));
    server.on('/licenses/verify/bulk', {
      status: 200,
      body: refs.map((ref) => ({
        licensed: false,
        tier: 'free',
        features: [],
        license_id: null,
        expires_at: null,
        subject: { type: 'discord_guild', ref },
      })),
    });
    const client = makeClient(server);

    const answers = await client.verifySubjects('api-key', refs);

    expect(answers).toHaveLength(100);
    expect(server.calls).toHaveLength(1);
  });

  it('refuses more than the server accepts, without sending them', async () => {
    const client = makeClient(server);
    const refs = Array.from({ length: 101 }, (_, index) => String(index));

    await expect(client.verifySubjects('api-key', refs)).rejects.toBeInstanceOf(ValidationError);
    expect(server.calls).toHaveLength(0);
  });

  it('sends nothing at all for an empty list', async () => {
    const client = makeClient(server);
    expect(await client.verifySubjects('api-key', [])).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// A read that does not write
// -----------------------------------------------------------------------------

describe('deviceStatus', () => {
  it('reads without adopting anything', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on('/licenses/device/status', {
      status: 200,
      body: statusBody({ status: 'suspended' }),
    });
    const client = makeClient(server);
    await client.activate('k');

    const status = await client.deviceStatus();

    expect(status.status).toBe('suspended');
    // The cached decision is untouched: this is a read for a diagnostics
    // screen, and a "check now" button that quietly extended the offline window
    // it was reporting on would be worse than no button.
    expect(client.state).toBe('ACTIVE');
    expect(server.calls.at(-1)!.method).toBe('GET');
  });

  it('refreshes a stale device token once, like the heartbeat does', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on(
      '/licenses/device/status',
      { status: 401, body: { error: { code: 'Unauthorized', message: 'stale' } } },
      { status: 200, body: statusBody() },
    );
    server.on('/licenses/device/token/refresh', {
      status: 200,
      body: activationBody({ device_access_token: 'device-token-2' }),
    });
    const client = makeClient(server);
    await client.activate('k');

    await client.deviceStatus();

    expect(server.calls.at(-1)!.token).toBe('device-token-2');
  });
});

// -----------------------------------------------------------------------------
// Concurrency
// -----------------------------------------------------------------------------

describe('overlapping calls', () => {
  it('makes one heartbeat out of three simultaneous ensure calls', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on('/licenses/device/heartbeat', { status: 200, body: statusBody() });
    const client = makeClient(server, { now: () => new Date('2026-03-02T09:00:00Z') });
    await client.activate('k');
    const before = server.calls.length;

    await Promise.all([client.ensure(), client.ensure(), client.ensure()]);

    // Three windows of an Electron application at start-up. Without the guard
    // this is three round trips, three nonces and three cache writes racing.
    expect(server.calls.length - before).toBe(1);
  });

  it('lets a later call check in again', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on('/licenses/device/heartbeat', { status: 200, body: statusBody() });
    const client = makeClient(server, { now: () => new Date('2026-03-02T09:00:00Z') });
    await client.activate('k');
    const before = server.calls.length;

    await client.ensure();
    await client.ensure();

    // Sequential, not concurrent: the guard must not turn into a cache.
    expect(server.calls.length - before).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

describe('events', () => {
  it('says why a cache was discarded', async () => {
    const events: LicenseEvent[] = [];
    const storage = new MemoryStorage();
    await storage.write(Buffer.from('not json at all', 'utf8'));
    const client = makeClient(server, { storage, onEvent: (e: LicenseEvent) => events.push(e) });

    await client.load();

    const discarded = events.find((event) => event.type === 'cache.discarded');
    expect(discarded).toBeDefined();
    // The caller still sees the ordinary answer; the event is the only place
    // the reason exists at all.
    expect(client.state).toBe('NOT_ACTIVATED');
  });

  it('distinguishes a cache from another machine from a corrupt one', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    await makeClient(server, { storage }).activate('k');

    const events: LicenseEvent[] = [];
    const elsewhere = makeClient(server, {
      storage,
      device: { fingerprint: 'b'.repeat(64), components: {} },
      onEvent: (e: LicenseEvent) => events.push(e),
    });
    await elsewhere.load();

    expect(events.find((event) => event.type === 'cache.discarded')).toMatchObject({
      reason: 'wrong-machine',
    });
  });

  it('reports a retry', async () => {
    const events: LicenseEvent[] = [];
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls === 1) return new Response('{}', { status: 503 });
          return new Response('{}', { status: 200 });
        };
      })() as unknown as typeof fetch,
      sleep: async () => undefined,
      random: () => 0.5,
      onEvent: (event) => events.push(event),
    });

    await transport.request('/x');

    expect(events.map((event) => event.type)).toContain('request.retry');
  });

  it('survives a listener that throws', async () => {
    // Observability is never allowed to be the thing that stops an application
    // starting.
    const storage = new MemoryStorage();
    const client = makeClient(server, {
      storage,
      onEvent: () => {
        throw new Error('the log handler exploded');
      },
    });

    await expect(client.load()).resolves.toBeDefined();
  });

  it('reports a state change once, not on every read', () => {
    const events: LicenseEvent[] = [];
    const client = makeClient(server, { onEvent: (e: LicenseEvent) => events.push(e) });

    void client.evaluation;
    void client.evaluation;
    void client.evaluation;

    expect(events.filter((event) => event.type === 'state.changed')).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// The clock mark
// -----------------------------------------------------------------------------

describe('the clock mark', () => {
  it('moves forward when the application is merely opened', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    await makeClient(server, { storage }).activate('k');

    // Four days later, still offline: no heartbeat, only a start-up.
    const friday = new Date('2026-03-05T09:00:00Z');
    const later = makeClient(server, { storage, now: () => friday });
    await later.load();

    expect(later.snapshot!.clockHighWater).toBe(friday.toISOString());
  });

  it('locks when the clock is then wound back past the tolerance', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    await makeClient(server, { storage }).activate('k');

    await makeClient(server, { storage, now: () => new Date('2026-03-05T09:00:00Z') }).load();

    // Without the mark advancing on load, Monday's value would still be stored
    // and this would look like an ordinary Monday.
    const wound = makeClient(server, {
      storage,
      now: () => new Date('2026-03-01T09:00:00Z'),
    });
    expect((await wound.load()).state).toBe('LOCKED_CLOCK');
  });

  it('never moves it backwards', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    await makeClient(server, { storage, now: () => new Date('2026-03-05T09:00:00Z') }).activate(
      'k',
    );

    // An hour earlier - inside the tolerance, so not a lock, and the mark must
    // still not go down.
    const earlier = makeClient(server, {
      storage,
      now: () => new Date('2026-03-05T08:00:00Z'),
    });
    await earlier.load();

    expect(earlier.snapshot!.clockHighWater).toBe(new Date('2026-03-05T09:00:00Z').toISOString());
  });
});

// -----------------------------------------------------------------------------
// The signature, re-checked properly
// -----------------------------------------------------------------------------

describe('verifyCachedSignature', () => {
  const vectors = JSON.parse(readFileSync(join(VECTOR_DIR, 'signature.json'), 'utf8')) as {
    keyId: string;
    publicKey: string;
    valid: { envelope: { alg: string; key_id: string; payload: string; signature: string } };
  };
  const claims = JSON.parse(
    Buffer.from(vectors.valid.envelope.payload, 'base64url').toString('utf8'),
  ) as Record<string, string>;

  /**
   * Write a sealed cache by hand, holding the signed envelope from the vectors.
   *
   * Going through `activate` is not an option: it verifies the nonce before it
   * stores anything, and the vector's nonce belongs to the request that
   * produced it. Sealing the file directly is exactly what the client does on
   * the next line anyway, and it is the only way to ask "what does this client
   * make of a cache that already exists?".
   */
  async function seedCache(
    storage: MemoryStorage,
    fingerprint: string,
    productSlug: string,
    licenseId: string,
  ): Promise<void> {
    const cached = {
      version: 1,
      snapshot: {
        licenseId,
        product: productSlug,
        type: 'subscription',
        status: 'active',
        tier: 'pro',
        features: ['teams'],
        seatId: 42,
        deviceFingerprint: fingerprint,
        notBefore: null,
        expiresAt: '2026-12-31T23:59:59+00:00',
        offlineValidUntil: '2026-03-08T09:00:00+00:00',
        nextCheckAfter: '2026-03-01T21:00:00+00:00',
        gracePeriodDays: 7,
        maxVersion: null,
        lastCheckAt: '2026-03-01T09:00:00.000Z',
        clockHighWater: '2026-03-01T09:00:00.000Z',
        seats: null,
        warnings: [],
      },
      deviceAccessToken: 'a',
      deviceRefreshToken: 'b',
      signedLicense: vectors.valid.envelope,
      apiBaseUrl: 'https://api.example.test/api/v1',
    };
    const nonce = Buffer.alloc(12, 3);
    const sealed = sealWithNonce(
      Buffer.from(canonicalJson(cached as never), 'utf8'),
      fingerprint,
      productSlug,
      nonce,
    );
    await storage.write(
      Buffer.from(
        JSON.stringify({
          v: 1,
          alg: 'AES-256-GCM',
          nonce: nonce.toString('base64'),
          ciphertext: Buffer.from(sealed).toString('base64'),
        }),
        'utf8',
      ),
    );
  }

  it('is false when there is nothing to check', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const client = makeClient(server);
    await client.activate('k');

    expect(client.verifyCachedSignature()).toBe(false);
  });

  it('is false before anything has been loaded', () => {
    expect(makeClient(server).verifyCachedSignature()).toBe(false);
  });

  it('accepts an envelope that matches the cache beside it', async () => {
    const storage = new MemoryStorage();
    await seedCache(storage, claims.device_fingerprint!, claims.product!, claims.license_id!);
    const events: LicenseEvent[] = [];
    const client = makeClient(server, {
      storage,
      productSlug: claims.product,
      device: { fingerprint: claims.device_fingerprint, components: {} },
      onEvent: (e: LicenseEvent) => events.push(e),
    });
    await client.load();

    expect(client.verifyCachedSignature()).toBe(true);
    expect(events.some((event) => event.type === 'signature.verified')).toBe(true);
  });

  it('rejects an envelope issued for another product', async () => {
    // A genuine signature over somebody else's product verifies perfectly. The
    // maths is not the question; what the claims say about *this* cache is.
    const storage = new MemoryStorage();
    await seedCache(storage, claims.device_fingerprint!, 'flashtrix', claims.license_id!);
    const client = makeClient(server, {
      storage,
      productSlug: 'flashtrix',
      device: { fingerprint: claims.device_fingerprint, components: {} },
    });
    await client.load();

    expect(client.verifyCachedSignature()).toBe(false);
  });

  it('rejects an envelope issued for another machine', async () => {
    const storage = new MemoryStorage();
    const otherMachine = 'c'.repeat(64);
    await seedCache(storage, otherMachine, claims.product!, claims.license_id!);
    const client = makeClient(server, {
      storage,
      productSlug: claims.product,
      device: { fingerprint: otherMachine, components: {} },
    });
    await client.load();

    expect(client.verifyCachedSignature()).toBe(false);
  });

  it('rejects an envelope naming a different licence than the snapshot', async () => {
    // The cache assembled from parts: a real envelope, a real snapshot, and
    // they are not about the same licence.
    const storage = new MemoryStorage();
    await seedCache(storage, claims.device_fingerprint!, claims.product!, 'lic_somebody_else');
    const events: LicenseEvent[] = [];
    const client = makeClient(server, {
      storage,
      productSlug: claims.product,
      device: { fingerprint: claims.device_fingerprint, components: {} },
      onEvent: (e: LicenseEvent) => events.push(e),
    });
    await client.load();

    expect(client.verifyCachedSignature()).toBe(false);
    expect(events.find((event) => event.type === 'signature.rejected')).toMatchObject({
      reason: expect.stringContaining('licence'),
    });
  });

  it('rejects an envelope signed by a key this build does not know', async () => {
    const storage = new MemoryStorage();
    await seedCache(storage, claims.device_fingerprint!, claims.product!, claims.license_id!);
    const events: LicenseEvent[] = [];
    const client = makeClient(server, {
      storage,
      productSlug: claims.product,
      device: { fingerprint: claims.device_fingerprint, components: {} },
      // A client older than the key rotation. Never "try them all": an unknown
      // key id means say so.
      publicKeys: { some_other_key: vectors.publicKey },
      onEvent: (e: LicenseEvent) => events.push(e),
    });
    await client.load();

    expect(client.verifyCachedSignature()).toBe(false);
    expect(events.some((event) => event.type === 'signature.rejected')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The cache, when it is the wrong cache
// -----------------------------------------------------------------------------

describe('a cache this version cannot use', () => {
  it('discards one written by a future format', async () => {
    const storage = new MemoryStorage();
    await storage.write(
      Buffer.from(JSON.stringify({ v: 99, alg: 'AES-256-GCM', nonce: '', ciphertext: '' })),
    );
    const events: LicenseEvent[] = [];
    const client = makeClient(server, { storage, onEvent: (e: LicenseEvent) => events.push(e) });

    expect((await client.load()).state).toBe('NOT_ACTIVATED');
    expect(events.find((event) => event.type === 'cache.discarded')).toMatchObject({
      reason: 'wrong-format',
    });
    // And it is removed, so the next start does not pay for it again.
    expect(await storage.read()).toBeNull();
  });

  it('discards one that decrypts but holds the wrong shape inside', async () => {
    // The outer container is this version's, the key is right, and the payload
    // is from something else entirely - a partially written file, or a hand
    // edit. It has to fail as "not activated", not as a crash on a missing
    // field three calls later.
    const storage = new MemoryStorage();
    const nonce = Buffer.alloc(12, 5);
    const sealed = sealWithNonce(
      Buffer.from(JSON.stringify({ version: 99, snapshot: null }), 'utf8'),
      FINGERPRINT,
      'teampromanager',
      nonce,
    );
    await storage.write(
      Buffer.from(
        JSON.stringify({
          v: 1,
          alg: 'AES-256-GCM',
          nonce: nonce.toString('base64'),
          ciphertext: Buffer.from(sealed).toString('base64'),
        }),
      ),
    );
    const events: LicenseEvent[] = [];
    const client = makeClient(server, { storage, onEvent: (e: LicenseEvent) => events.push(e) });

    expect((await client.load()).state).toBe('NOT_ACTIVATED');
    expect(events.find((event) => event.type === 'cache.discarded')).toMatchObject({
      reason: 'unreadable',
    });
  });

  it('clears the file when the cache is dropped rather than leaving it', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    const client = makeClient(server, { storage });
    await client.activate('k');
    expect(await storage.read()).not.toBeNull();

    await client.reset();

    expect(await storage.read()).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The rest of the surface
// -----------------------------------------------------------------------------

describe('the rest of the surface', () => {
  it('reports the fingerprint it is using', () => {
    expect(makeClient(server).fingerprint).toBe(FINGERPRINT);
  });

  it('fetches one licence by id', async () => {
    server.on('/licenses/lic_2f8a1c', {
      status: 200,
      body: { public_id: 'lic_2f8a1c', tier: 'pro' },
    });
    const client = makeClient(server);

    const licence = await client.getLicense('user-token', 'lic_2f8a1c');

    expect(licence.public_id).toBe('lic_2f8a1c');
    expect(server.calls[0]!.token).toBe('user-token');
  });

  it('lists the features a running licence covers', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const client = makeClient(server);
    await client.activate('k');

    expect(client.grantedFeatures(['teams', 'sso', 'tasks'])).toEqual(['teams', 'tasks']);
  });

  it('normalises whatever base URL it was given', () => {
    for (const given of [
      'https://api.example.test',
      'https://api.example.test/',
      'https://api.example.test/api/v1',
      'https://api.example.test/api/v1/',
      'https://api.example.test/v1',
    ]) {
      expect(makeClient(server, { apiBaseUrl: given }).apiBaseUrl).toBe(
        'https://api.example.test/api/v1',
      );
    }
  });
});

// -----------------------------------------------------------------------------
// Feature lookup, prepared
// -----------------------------------------------------------------------------

describe('FeatureIndex', () => {
  it('answers exactly what the linear lookup does', () => {
    const granted = ['teams', 'export.*', 'reports.monthly'];
    const index = new FeatureIndex(granted);

    for (const feature of [
      'teams',
      'export.csv',
      'export.',
      'export',
      'exportable',
      'reports.monthly',
      'reports.weekly',
      '',
      'anything',
    ]) {
      expect(index.has(feature), feature).toBe(
        // The same rules, stated the other way round: a wildcard is a prefix
        // rule on the granted side only.
        granted.some(
          (entry) =>
            feature !== '' &&
            (entry === '*' ||
              entry === feature ||
              (entry.endsWith('*') &&
                entry.slice(0, -1) !== '' &&
                feature.startsWith(entry.slice(0, -1)))),
        ),
      );
    }
  });

  it('short-circuits a licence that grants everything', () => {
    const index = new FeatureIndex(['*']);
    expect(index.has('anything at all')).toBe(true);
    expect(index.has('')).toBe(false);
  });

  it('does not let a lone star become an empty prefix', () => {
    // '*' is handled as "everything"; the prefix list must not also gain an
    // empty entry, which would match every query including the empty one.
    const index = new FeatureIndex(['*']);
    expect(index.granted(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('is rebuilt when the licence changes, not mutated', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on('/licenses/device/heartbeat', {
      status: 200,
      body: statusBody({ features: ['teams'] }),
    });
    const client = makeClient(server, { now: () => new Date('2026-03-02T09:00:00Z') });
    await client.activate('k');
    expect(client.hasFeature('time_tracking')).toBe(true);

    await client.heartbeat();

    expect(client.hasFeature('time_tracking')).toBe(false);
    expect(client.hasFeature('teams')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// What to put in front of a person
// -----------------------------------------------------------------------------

describe('banner helpers', () => {
  it('counts whole days to expiry', async () => {
    server.on('/licenses/device/activate', {
      status: 201,
      body: activationBody({
        license: statusBody({ expires_at: '2026-03-08T09:00:00+00:00' }),
      }),
    });
    const client = makeClient(server);
    await client.activate('k');

    expect(client.daysUntilExpiry).toBe(7);
  });

  it('answers null for a licence that does not expire', async () => {
    server.on('/licenses/device/activate', {
      status: 201,
      body: activationBody({
        license: statusBody({ type: 'perpetual', expires_at: null }),
      }),
    });
    const client = makeClient(server);
    await client.activate('k');

    expect(client.daysUntilExpiry).toBeNull();
  });

  it('passes the server warnings through unchanged', async () => {
    server.on('/licenses/device/activate', {
      status: 201,
      body: activationBody({
        license: statusBody({ warnings: ['expires_in_7_days', 'vm_detected'] }),
      }),
    });
    const client = makeClient(server);
    await client.activate('k');

    // Identifiers, not sentences: an application looks them up in its own
    // message table, and shipping English from here would break every
    // localised product.
    expect(client.warnings).toEqual(['expires_in_7_days', 'vm_detected']);
  });

  it('reports no granted features while the licence may not run', async () => {
    server.on('/licenses/device/activate', {
      status: 201,
      body: activationBody({ license: statusBody({ status: 'revoked' }) }),
    });
    const client = makeClient(server);
    await client.activate('k');

    expect(client.grantedFeatures(['teams', 'tasks'])).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// A licence that belongs to a guild rather than a machine
// -----------------------------------------------------------------------------

describe('subjects', () => {
  it('sends the subject given to the constructor', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const client = makeClient(server, {
      subject: { type: 'discord_guild', ref: '123' },
    });

    await client.activate('k');

    expect((server.calls[0]!.body as { subject: unknown }).subject).toEqual({
      type: 'discord_guild',
      ref: '123',
    });
  });

  it('lets the call override it', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const client = makeClient(server, {
      subject: { type: 'discord_guild', ref: '123' },
    });

    await client.activate('k', { type: 'discord_guild', ref: '456' });

    expect((server.calls[0]!.body as { subject: { ref: string } }).subject.ref).toBe('456');
  });

  it('sends none when there is none', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const client = makeClient(server);

    await client.activate('k');

    expect(server.calls[0]!.body).not.toHaveProperty('subject');
  });
});

// -----------------------------------------------------------------------------
// The memo
// -----------------------------------------------------------------------------

describe('the evaluation memo', () => {
  it('does not go stale when the clock moves', async () => {
    server.on('/licenses/device/activate', {
      status: 201,
      body: activationBody({
        license: statusBody({ expires_at: '2026-03-01T09:00:10+00:00' }),
      }),
    });
    let clock = new Date('2026-03-01T09:00:00Z');
    const client = makeClient(server, { now: () => clock });
    await client.activate('k');
    expect(client.state).toBe('ACTIVE');

    clock = new Date('2026-03-01T09:00:20Z');

    // A memo keyed only on the snapshot would still say ACTIVE here.
    expect(client.state).toBe('LOCKED_EXPIRED');
  });

  it('is dropped when the cache is', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const client = makeClient(server);
    await client.activate('k');
    expect(client.state).toBe('ACTIVE');

    await client.reset();

    expect(client.state).toBe('NOT_ACTIVATED');
  });

  it('answers the same thing whether or not it was cached', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const client = makeClient(server);
    await client.activate('k');

    const first = client.evaluation;
    const second = client.evaluation;

    expect(second).toBe(first);
    expect(second.state).toBe('ACTIVE');
  });
});

// -----------------------------------------------------------------------------
// The abort signal, which must never be retried
// -----------------------------------------------------------------------------

describe('cancellation', () => {
  it('does not retry a request the caller cancelled', async () => {
    let calls = 0;
    const controller = new AbortController();
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async () => {
        calls += 1;
        throw new TypeError('aborted');
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    controller.abort();
    await expect(
      transport.request('/x', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toBe(1);
  });

  it('does not leave a listener on a signal it was given', async () => {
    const controller = new AbortController();
    const spy = vi.spyOn(controller.signal, 'removeEventListener');
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });

    await transport.request('/x', { signal: controller.signal });

    // A long-lived signal accumulating one listener per request is a leak that
    // only shows up after a day of heartbeats.
    expect(spy).toHaveBeenCalled();
  });
});
