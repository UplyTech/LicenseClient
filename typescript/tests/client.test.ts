/**
 * The client against a stand-in server.
 *
 * What is being checked here is the behaviour that decides whether a paying
 * customer can work: a copied cache, a flat network, an expired device token,
 * a revoked licence. Each of those has a right answer, and most licence
 * systems get at least one of them wrong.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { LicenseClient } from '../src/client.js';
import { ApiError, NetworkError, SeatLimitError } from '../src/errors.js';
import { MemoryStorage } from '../src/storage.js';
import type { ActivationResponse, LicenseStatusResponse } from '../src/types.js';

const VECTOR_DIR = join(__dirname, '..', '..', 'shared', 'testcases');
const signatureVectors = JSON.parse(
  readFileSync(join(VECTOR_DIR, 'signature.json'), 'utf8'),
) as { publicKey: string; keyId: string };

const FINGERPRINT = '0da041751176c4024de409802c69467bd2a47366c705815dc3acc5339b1a873d';
const OTHER_FINGERPRINT = '48d8ad1cb89811574994f6ce5776f7b6ffedcc856241a48b9c1ba35903fbf2de';

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
    // Unsigned: the signature path has its own vectors, and mixing the two
    // would make this file test the wrong thing.
    signed_license: null,
    warnings: [],
    ...overrides,
  };
}

interface Route {
  status: number;
  body: unknown;
}

class FakeServer {
  readonly calls: { path: string; body: unknown; token?: string }[] = [];
  private routes = new Map<string, Route[]>();
  offline = false;

  on(path: string, ...responses: Route[]): void {
    this.routes.set(path, responses);
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/v1', '');

    if (this.offline) throw new TypeError('fetch failed');

    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    this.calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      token: auth?.replace('Bearer ', ''),
    });

    const queued = this.routes.get(path);
    if (!queued || queued.length === 0) {
      return new Response(JSON.stringify({ error: { code: 'NotFound', message: 'no route' } }), {
        status: 404,
      });
    }
    // The last response repeats, so a test only has to describe what changes.
    const route = queued.length > 1 ? queued.shift()! : queued[0]!;
    if (route.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'Content-Type': 'application/json' },
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

describe('activation', () => {
  it('activates, stores a sealed cache and reports ACTIVE', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    const client = makeClient(server, { storage });

    const result = await client.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');

    expect(result.state).toBe('ACTIVE');
    expect(result.canRun).toBe(true);
    expect(client.hasFeature('time_tracking')).toBe(true);
    expect(client.hasFeature('sso')).toBe(false);

    const stored = await storage.read();
    expect(stored).not.toBeNull();
    // The cache must not be readable with a text editor: the tier and the
    // expiry are exactly what somebody would edit.
    expect(Buffer.from(stored!).toString('utf8')).not.toContain('teampromanager');
  });

  it('sends hashed components and never the raw values', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    await makeClient(server).activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');

    const sent = server.calls[0]!.body as { device: { components: Record<string, string> } };
    for (const value of Object.values(sent.device.components)) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('turns a full licence into a SeatLimitError that names the machines', async () => {
    server.on('/licenses/device/activate', {
      status: 409,
      body: {
        error: {
          code: 'SeatLimitReached',
          message: 'All 2 seats of this licence are in use',
          detail: {
            seats: { total: 2, used: 2, available: 0 },
            active_seats: [
              {
                id: 7,
                device_name: 'Laptop',
                platform: 'win32',
                app_version: '2.0.0',
                status: 'active',
                last_seen_at: '2026-02-28T10:00:00+00:00',
                activated_at: '2026-01-05T10:00:00+00:00',
              },
            ],
          },
        },
      },
    });

    const client = makeClient(server);
    await expect(client.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W')).rejects.toBeInstanceOf(
      SeatLimitError,
    );
    // Without the list the application can only say "contact support".
    await expect(
      client.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W').catch((e: SeatLimitError) => e.seats),
    ).resolves.toMatchObject({ seats: { total: 2 } });
  });
});

describe('the cache', () => {
  it('survives a restart', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    await makeClient(server, { storage }).activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');

    const restarted = makeClient(server, { storage });
    expect((await restarted.load()).state).toBe('ACTIVE');
    expect(restarted.hasFeature('tasks')).toBe(true);
  });

  it('does not open on another machine', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    await makeClient(server, { storage }).activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');

    // The whole copy protection: the file was carried to a second computer.
    const thief = makeClient(server, {
      storage,
      device: { fingerprint: OTHER_FINGERPRINT, components: {} },
    });
    expect((await thief.load()).state).toBe('NOT_ACTIVATED');
  });

  it('discards a damaged cache instead of refusing to start', async () => {
    const storage = new MemoryStorage();
    await storage.write(Buffer.from('this is not even JSON', 'utf8'));

    const client = makeClient(server, { storage });
    const result = await client.load();

    expect(result.state).toBe('NOT_ACTIVATED');
    // And it cleans up, so the same broken file is not re-read every start.
    expect(await storage.read()).toBeNull();
  });

  it('discards a cache written by a future version', async () => {
    const storage = new MemoryStorage();
    await storage.write(Buffer.from(JSON.stringify({ v: 99, nonce: '', ciphertext: '' }), 'utf8'));
    expect((await makeClient(server, { storage }).load()).state).toBe('NOT_ACTIVATED');
  });
});

describe('heartbeat', () => {
  it('refreshes an expired device token once and retries', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on(
      '/licenses/device/heartbeat',
      { status: 401, body: { error: { code: 'Unauthorized', message: 'expired' } } },
      { status: 200, body: statusBody() },
    );
    server.on('/licenses/device/token/refresh', {
      status: 200,
      body: activationBody({
        device_access_token: 'device-token-2',
        device_refresh_token: 'refresh-token-2',
      }),
    });

    const client = makeClient(server);
    await client.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');
    const result = await client.heartbeat();

    expect(result.state).toBe('ACTIVE');
    const refreshed = server.calls.filter((c) => c.path === '/licenses/device/token/refresh');
    expect(refreshed).toHaveLength(1);
    // The retry has to carry the *new* token, not the one that just failed.
    const beats = server.calls.filter((c) => c.path === '/licenses/device/heartbeat');
    expect(beats.at(-1)!.token).toBe('device-token-2');
  });

  it('gives up after one refresh rather than looping', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on('/licenses/device/heartbeat', {
      status: 401,
      body: { error: { code: 'Unauthorized', message: 'seat revoked' } },
    });
    server.on('/licenses/device/token/refresh', {
      status: 200,
      body: activationBody({ device_access_token: 'device-token-2' }),
    });

    const client = makeClient(server);
    await client.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');
    await expect(client.heartbeat()).rejects.toBeInstanceOf(ApiError);
  });

  it('adopts a revocation the server reports', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on('/licenses/device/heartbeat', {
      status: 200,
      body: statusBody({ status: 'revoked' }),
    });

    const client = makeClient(server);
    await client.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');
    const result = await client.heartbeat();

    expect(result.state).toBe('LOCKED_REVOKED');
    expect(client.hasFeature('tasks')).toBe(false);
  });
});

describe('ensure', () => {
  it('keeps working when the server cannot be reached', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    await makeClient(server, { storage }).activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');

    server.offline = true;
    // Two days later - past the check-in time, well inside the offline window.
    const client = makeClient(server, {
      storage,
      now: () => new Date('2026-03-03T09:00:00Z'),
    });
    const result = await client.ensure();

    expect(result.state).toBe('ACTIVE');
    expect(result.shouldCheckIn).toBe(true);
  });

  it('locks once the offline window has run out', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    await makeClient(server, { storage }).activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');

    server.offline = true;
    const client = makeClient(server, {
      storage,
      now: () => new Date('2026-03-10T09:00:00Z'),
    });
    expect((await client.ensure()).state).toBe('LOCKED_OFFLINE');
  });

  it('does not call out when nothing is due', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    await makeClient(server, { storage }).activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');

    const before = server.calls.length;
    await makeClient(server, { storage }).ensure();
    expect(server.calls).toHaveLength(before);
  });

  it('treats a server fault as a connection problem, not a licence problem', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on('/licenses/device/heartbeat', {
      status: 503,
      body: { error: { code: 'ServiceUnavailable', message: 'maintenance' } },
    });

    const storage = new MemoryStorage();
    await makeClient(server, { storage }).activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');
    const client = makeClient(server, {
      storage,
      now: () => new Date('2026-03-03T09:00:00Z'),
    });

    expect((await client.ensure()).state).toBe('ACTIVE');
  });

  it('surfaces a refusal the server actually made', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on('/licenses/device/heartbeat', {
      status: 403,
      body: { error: { code: 'Forbidden', message: 'This licence has been revoked' } },
    });

    const storage = new MemoryStorage();
    await makeClient(server, { storage }).activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');
    const client = makeClient(server, {
      storage,
      now: () => new Date('2026-03-03T09:00:00Z'),
    });

    await expect(client.ensure()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('deactivate', () => {
  it('frees the seat and forgets the licence', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    server.on('/licenses/device/deactivate', { status: 204, body: null });

    const storage = new MemoryStorage();
    const client = makeClient(server, { storage });
    await client.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');
    await client.deactivate();

    expect(client.state).toBe('NOT_ACTIVATED');
    expect(await storage.read()).toBeNull();
    expect(server.calls.some((c) => c.path === '/licenses/device/deactivate')).toBe(true);
  });

  it('still forgets locally when the server is unreachable', async () => {
    server.on('/licenses/device/activate', { status: 201, body: activationBody() });
    const storage = new MemoryStorage();
    const client = makeClient(server, { storage });
    await client.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');

    server.offline = true;
    await client.deactivate();

    // Telling the user the licence is removed and then keeping it would be
    // worse than the orphaned seat, which the server reclaims on its own.
    expect(client.state).toBe('NOT_ACTIVATED');
    expect(await storage.read()).toBeNull();
  });
});

describe('network failures', () => {
  it('are a NetworkError, distinct from a rejection', async () => {
    server.offline = true;
    await expect(makeClient(server).activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W')).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('time out rather than hanging the application', async () => {
    const stalling: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    const client = makeClient(server, { fetch: stalling, requestTimeoutMs: 20 });
    await expect(client.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W')).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

describe('trials', () => {
  it('starts one against the signed-in user, not the machine', async () => {
    server.on('/licenses/device/trial', {
      status: 201,
      body: activationBody({
        license: statusBody({ status: 'trialing', type: 'trial', tier: 'trial' }),
      }),
    });

    const client = makeClient(server);
    const result = await client.startTrial('user-access-token');

    expect(result.state).toBe('ACTIVE');
    const call = server.calls.find((c) => c.path === '/licenses/device/trial')!;
    expect(call.token).toBe('user-access-token');
  });
});

describe('signature checking', () => {
  it('refuses an answer that was issued for a different request', async () => {
    const signature = JSON.parse(readFileSync(join(VECTOR_DIR, 'signature.json'), 'utf8')) as {
      valid: { envelope: unknown };
    };
    server.on('/licenses/device/activate', {
      status: 201,
      body: activationBody({ signed_license: signature.valid.envelope as never }),
    });

    // The envelope in the vectors carries its own nonce, which cannot be the
    // one this client just generated - so this is the replay case.
    await expect(makeClient(server).activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W')).rejects.toThrow(
      /answers a different request/,
    );
  });
});

describe('warnings', () => {
  it('passes the server hints through for the banner', async () => {
    server.on('/licenses/device/activate', {
      status: 201,
      body: activationBody({
        license: statusBody({ warnings: ['expires_in_7_days'] }),
        warnings: ['vm_suspected'],
      }),
    });

    const client = makeClient(server);
    await client.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');
    expect(client.snapshot?.warnings).toEqual(['expires_in_7_days', 'vm_suspected']);
  });
});

describe('the base url', () => {
  it('is normalised so a stored setting from an older version keeps working', () => {
    for (const raw of [
      'https://api.example.test',
      'https://api.example.test/',
      'https://api.example.test/v1',
      'https://api.example.test/api/v1',
      'https://api.example.test/api/v1/',
    ]) {
      expect(makeClient(server, { apiBaseUrl: raw }).apiBaseUrl).toBe(
        'https://api.example.test/api/v1',
      );
    }
  });
});

describe('a client with no cache', () => {
  it('refuses a heartbeat rather than pretending', async () => {
    const client = makeClient(server);
    await expect(client.heartbeat()).rejects.toThrow(/not activated/i);
  });

  it('does nothing on ensure', async () => {
    const client = makeClient(server);
    expect((await client.ensure()).state).toBe('NOT_ACTIVATED');
    expect(server.calls).toHaveLength(0);
  });

  it('does nothing on deactivate', async () => {
    const client = makeClient(server);
    await client.deactivate();
    expect(server.calls).toHaveLength(0);
  });
});
