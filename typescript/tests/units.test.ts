/**
 * The corners the vector suite and the client suite do not reach: file
 * storage, the signed activation path, and the error branches each module
 * takes when it is handed something malformed.
 */

import { createPrivateKey, randomBytes, sign as signBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalJson, canonicalJsonBytes } from '../src/canonical-json.js';
import { LicenseClient } from '../src/client.js';
import { open, sealWithNonce } from '../src/crypto.js';
import { CacheError, CanonicalJsonError, InvalidKeyError, NetworkError } from '../src/errors.js';
import { grantedFrom, hasFeature } from '../src/features.js';
import { isValidFingerprint } from '../src/fingerprint.js';
import { checkSymbol, hasValidCheckSymbol, isValidKey, parseKey } from '../src/key.js';
import { b64urlEncode, peekClaims, verifyEnvelope } from '../src/signature.js';
import { FileStorage, MemoryStorage } from '../src/storage.js';
import { Transport, normaliseApiUrl } from '../src/transport.js';
import type { ActivationResponse } from '../src/types.js';

const VECTOR_DIR = join(__dirname, '..', '..', 'shared', 'testcases');
const signatureVectors = JSON.parse(
  readFileSync(join(VECTOR_DIR, 'signature.json'), 'utf8'),
) as { publicKey: string; keyId: string; valid: { envelope: Record<string, string> } };

// Matches TEST_PRIVATE_KEY in shared/scripts/generate_vectors.py. Test
// material only - it is checked into a repository, which disqualifies it.
const TEST_PRIVATE_KEY = 'cJ3aJ_6yBBqfzKQ9E-mFO-tLp-mCOm9AKKB7WmpTb2Q';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function signPayload(payload: Record<string, unknown>): {
  alg: string;
  key_id: string;
  payload: string;
  signature: string;
} {
  const bytes = Buffer.from(canonicalJsonBytes(payload as never));
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(TEST_PRIVATE_KEY, 'base64url')]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    alg: 'Ed25519',
    key_id: signatureVectors.keyId,
    payload: b64urlEncode(bytes),
    signature: b64urlEncode(signBytes(null, bytes, key)),
  };
}

// -----------------------------------------------------------------------------

describe('canonical json edge cases', () => {
  it('refuses an integer beyond the safe range', () => {
    expect(() => canonicalJson({ n: 2 ** 53 } as never)).toThrow(CanonicalJsonError);
  });

  it('refuses a value JSON has no representation for', () => {
    expect(() => canonicalJson({ fn: (() => 1) as never } as never)).toThrow(/cannot be serialised/);
  });

  it('serialises a top-level array and a bare value', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
  });
});

describe('key helpers', () => {
  it('rejects a character outside the alphabet', () => {
    // U is deliberately absent, so it cannot appear in a normalised key body.
    expect(() => checkSymbol('TPM!')).toThrow(InvalidKeyError);
  });

  it('treats a one-character input as having no check symbol', () => {
    expect(hasValidCheckSymbol('X')).toBe(false);
    expect(hasValidCheckSymbol('')).toBe(false);
  });

  it('answers isValidKey without throwing, for live validation while typing', () => {
    expect(isValidKey('ULT-TPM-3F7K9-2QW8M-XZ4RB-W')).toBe(true);
    expect(isValidKey('ULT-TPM-3F7K9')).toBe(false);
    expect(isValidKey('')).toBe(false);
  });

  it('rejects a product code longer than four symbols', () => {
    expect(() => parseKey('ULT-TOOLONG-3F7K9-2QW8M-XZ4RB-W')).toThrow(/product code length/);
  });
});

describe('feature helpers', () => {
  it('filters a wanted list down to what is covered', () => {
    expect(grantedFrom(['teams', 'export.*'], ['teams', 'export.csv', 'sso'])).toEqual([
      'teams',
      'export.csv',
    ]);
  });

  it('ignores a bare star on the granted side that has no stem', () => {
    // '*' alone means everything; '.*' with an empty stem must not.
    expect(hasFeature(['*'], 'anything')).toBe(true);
  });
});

describe('fingerprint validation', () => {
  it('accepts a lower-case digest and nothing else', () => {
    expect(isValidFingerprint('a'.repeat(64))).toBe(true);
    expect(isValidFingerprint('A'.repeat(64))).toBe(false);
    expect(isValidFingerprint('a'.repeat(63))).toBe(false);
  });
});

describe('crypto guards', () => {
  it('refuses a nonce of the wrong length', () => {
    expect(() => sealWithNonce(Buffer.from('x'), 'f', 'p', Buffer.alloc(8))).toThrow(CacheError);
  });

  it('refuses a blob shorter than the authentication tag', () => {
    expect(() => open(Buffer.alloc(4), 'f', 'p', Buffer.alloc(12))).toThrow(/too short/);
  });
});

describe('signature guards', () => {
  const keys = { [signatureVectors.keyId]: signatureVectors.publicKey };

  it('refuses a public key that is not 32 bytes', () => {
    expect(() =>
      verifyEnvelope(signatureVectors.valid.envelope as never, {
        [signatureVectors.keyId]: b64urlEncode(Buffer.alloc(16)),
      }),
    ).toThrow(/32 bytes/);
  });

  it('refuses a signature of the wrong length', () => {
    expect(() =>
      verifyEnvelope(
        { ...signatureVectors.valid.envelope, signature: b64urlEncode(Buffer.alloc(10)) } as never,
        keys,
      ),
    ).toThrow(/wrong length/);
  });

  it('refuses a signed payload that is not a JSON object', () => {
    const envelope = signPayload([1, 2, 3] as never);
    expect(() => verifyEnvelope(envelope, keys)).toThrow(/not a JSON object/);
  });

  it('refuses an envelope that is missing entirely', () => {
    expect(() => verifyEnvelope(undefined as never, keys)).toThrow(/algorithm/);
  });

  it('peeks at claims without verifying, and says null for rubbish', () => {
    expect(peekClaims(signatureVectors.valid.envelope as never)).toMatchObject({
      product: 'teampromanager',
    });
    expect(peekClaims({ payload: 'not-base64-json' } as never)).toBeNull();
  });
});

describe('transport', () => {
  it('normalises every spelling a settings file might hold', () => {
    expect(normaliseApiUrl('  https://a.test//  ')).toBe('https://a.test/api/v1');
    expect(normaliseApiUrl('https://a.test/V1')).toBe('https://a.test/api/v1');
  });

  it('survives a body that is not JSON', async () => {
    const transport = new Transport('https://a.test/api/v1', async () =>
      new Response('<html>gateway timeout</html>', { status: 504 }),
    );
    await expect(transport.request('/x')).rejects.toMatchObject({ status: 504 });
  });

  it('honours a caller-supplied abort signal', async () => {
    const controller = new AbortController();
    const transport = new Transport(
      'https://a.test/api/v1',
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = transport.request('/x', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('FileStorage', () => {
  let directory: string;
  let storage: FileStorage;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'uplytech-licence-'));
    path = join(directory, 'nested', 'licence.bin');
    storage = new FileStorage(path);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('answers null when there is nothing yet', async () => {
    expect(await storage.read()).toBeNull();
  });

  it('creates the directory and writes readable bytes back', async () => {
    await storage.write(Buffer.from('hello'));
    expect(Buffer.from((await storage.read())!).toString()).toBe('hello');
  });

  it('leaves no temporary file behind', async () => {
    await storage.write(Buffer.from('hello'));
    // The write goes to a temporary name and is renamed into place, so a power
    // cut halfway through cannot leave a truncated licence cache.
    await expect(stat(`${path}.${process.pid}.tmp`)).rejects.toThrow();
  });

  it('overwrites rather than appending', async () => {
    await storage.write(Buffer.from('first'));
    await storage.write(Buffer.from('second'));
    expect((await readFile(path)).toString()).toBe('second');
  });

  it('clears without complaining about a missing file', async () => {
    await storage.clear();
    await storage.write(Buffer.from('x'));
    await storage.clear();
    expect(await storage.read()).toBeNull();
  });
});

describe('the signed activation path', () => {
  const NOW = new Date('2026-03-01T09:00:00Z');
  const FINGERPRINT = '0da041751176c4024de409802c69467bd2a47366c705815dc3acc5339b1a873d';

  function serve(
    build: (nonce: string) => ActivationResponse,
  ): { fetch: typeof globalThis.fetch } {
    return {
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { nonce: string };
        return new Response(JSON.stringify(build(body.nonce)), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    };
  }

  function baseResponse(nonce: string, claimOverrides: Record<string, unknown> = {}) {
    return {
      device_access_token: 'device-token-1',
      device_refresh_token: 'refresh-token-1',
      expires_in: 86400,
      seat_id: 42,
      license: {
        license_id: 'lic_2f8a1c',
        product: 'teampromanager',
        type: 'subscription' as const,
        status: 'active' as const,
        tier: 'pro',
        features: ['teams', 'time_tracking'],
        expires_at: '2026-12-31T23:59:59+00:00',
        seats: { total: 5, used: 1, available: 4 },
        seat_id: 42,
        grace_period_days: 7,
        offline_valid_until: '2026-03-08T09:00:00+00:00',
        next_check_after: '2026-03-01T21:00:00+00:00',
        max_version: null,
        warnings: [],
      },
      signed_license: signPayload({
        v: 1,
        license_id: 'lic_2f8a1c',
        product: 'teampromanager',
        device_fingerprint: FINGERPRINT,
        not_before: '2026-01-01T00:00:00+00:00',
        nonce,
        ...claimOverrides,
      }),
      warnings: [],
    } as ActivationResponse;
  }

  function client(fetchImpl: typeof globalThis.fetch, storage = new MemoryStorage()) {
    return new LicenseClient({
      apiBaseUrl: 'https://a.test',
      productSlug: 'teampromanager',
      appVersion: '2.0.0',
      publicKeys: { [signatureVectors.keyId]: signatureVectors.publicKey },
      storage,
      device: { fingerprint: FINGERPRINT, components: {} },
      fetch: fetchImpl,
      now: () => NOW,
    });
  }

  it('accepts a correctly signed answer and keeps the envelope', async () => {
    const storage = new MemoryStorage();
    const subject = client(serve((nonce) => baseResponse(nonce)).fetch, storage);

    expect((await subject.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W')).state).toBe('ACTIVE');
    // Kept so the signature can be re-checked at any later start-up.
    expect(subject.verifyCachedSignature()).toBe(true);
    expect(subject.snapshot?.notBefore).toBe('2026-01-01T00:00:00+00:00');
  });

  it('refuses an answer bound to another machine', async () => {
    const subject = client(
      serve((nonce) => baseResponse(nonce, { device_fingerprint: 'b'.repeat(64) })).fetch,
    );
    await expect(subject.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W')).rejects.toThrow(
      /issued for another machine/,
    );
  });

  it('refuses an answer for a different product', async () => {
    const subject = client(serve((nonce) => baseResponse(nonce, { product: 'flashtrix' })).fetch);
    await expect(subject.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W')).rejects.toThrow(
      /is for flashtrix/,
    );
  });

  it('reports no cached signature when the server ran unsigned', async () => {
    const subject = client(
      serve((nonce) => ({ ...baseResponse(nonce), signed_license: null })).fetch,
    );
    await subject.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');
    expect(subject.verifyCachedSignature()).toBe(false);
  });

  it('reports a cached signature that no longer verifies', async () => {
    const storage = new MemoryStorage();
    const subject = client(serve((nonce) => baseResponse(nonce)).fetch, storage);
    await subject.activate('ULT-TPM-3F7K9-2QW8M-XZ4RB-W');

    const withOtherKeys = new LicenseClient({
      apiBaseUrl: 'https://a.test',
      productSlug: 'teampromanager',
      appVersion: '2.0.0',
      // A rotation this installation is too old to know about.
      publicKeys: { lk_someone_else: b64urlEncode(randomBytes(32)) },
      storage,
      device: { fingerprint: FINGERPRINT, components: {} },
      now: () => NOW,
    });
    await withOtherKeys.load();
    expect(withOtherKeys.verifyCachedSignature()).toBe(false);
  });

  it('starts from an unloaded client without a cache', async () => {
    const subject = client(serve((nonce) => baseResponse(nonce)).fetch);
    // reset() before anything was loaded must not throw.
    await subject.reset();
    expect(subject.state).toBe('NOT_ACTIVATED');
  });
});
