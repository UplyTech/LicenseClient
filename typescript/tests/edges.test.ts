/**
 * The branches nothing else reaches.
 *
 * Every one of these is a path that only runs when something has already gone
 * wrong - a malformed date in a snapshot, a public key that is the right length
 * and still not a key, a licence file on a directory the user cannot read. They
 * are the paths least likely to be exercised by hand and most likely to decide
 * whether an application starts, so they are worth stating explicitly rather
 * than leaving to a coverage percentage.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CanonicalJsonError, SignatureError } from '../src/errors.js';
import { compareComponents } from '../src/fingerprint.js';
import { hasValidCheckSymbol } from '../src/key.js';
import { delay, parseRetryAfter } from '../src/retry.js';
import { compareVersions, isValidVersion, parseVersion } from '../src/semver.js';
import { peekClaims, verifyEnvelope, b64urlEncode } from '../src/signature.js';
import { checkClock, evaluate } from '../src/state.js';
import { FileStorage } from '../src/storage.js';
import { Transport } from '../src/transport.js';
import { canonicalJson } from '../src/canonical-json.js';
import type { LicenseSnapshot } from '../src/types.js';

// -----------------------------------------------------------------------------
// A snapshot whose dates are wrong
// -----------------------------------------------------------------------------

function snapshot(overrides: Partial<LicenseSnapshot> = {}): LicenseSnapshot {
  return {
    licenseId: 'lic_1',
    product: 'teampromanager',
    type: 'subscription',
    status: 'active',
    tier: 'pro',
    features: [],
    seatId: 1,
    deviceFingerprint: null,
    notBefore: null,
    expiresAt: null,
    offlineValidUntil: null,
    nextCheckAfter: null,
    gracePeriodDays: 7,
    maxVersion: null,
    lastCheckAt: '2026-03-01T09:00:00+00:00',
    clockHighWater: '2026-03-01T09:00:00+00:00',
    seats: null,
    warnings: [],
    ...overrides,
  };
}

describe('dates this library cannot read', () => {
  const now = new Date('2026-03-01T12:00:00Z');

  it('treats an unparseable expiry as no expiry rather than as the epoch', () => {
    // The dangerous reading is the other one: `Date.parse` of nonsense is NaN,
    // and a comparison against NaN is false in every direction. Parsing to null
    // and branching on it explicitly is what keeps that from becoming "expired
    // in 1970" or "never expires" by accident.
    const result = evaluate(snapshot({ expiresAt: 'the first of never' }), now);
    expect(result.state).toBe('ACTIVE');
  });

  it('treats an unparseable offline window as no window', () => {
    const result = evaluate(snapshot({ offlineValidUntil: 'soon' }), now);
    expect(result.state).toBe('ACTIVE');
    expect(result.daysLeftOffline).toBeNull();
  });

  it('checks in when it cannot tell when the next check is due', () => {
    // Erring towards asking the server: the alternative is a client that never
    // checks in again because one field was written badly once.
    expect(evaluate(snapshot({ nextCheckAfter: 'later' }), now).shouldCheckIn).toBe(true);
    expect(evaluate(snapshot({ nextCheckAfter: null }), now).shouldCheckIn).toBe(true);
  });

  it('treats an unparseable clock mark as no mark', () => {
    const result = checkClock(now, 'not a date');
    expect(result.rolledBack).toBe(false);
    expect(result.newHighWater).toBe(now.toISOString());
  });

  it('treats an empty clock mark as no mark', () => {
    expect(checkClock(now, '').newHighWater).toBe(now.toISOString());
    expect(checkClock(now, null).newHighWater).toBe(now.toISOString());
    expect(checkClock(now, undefined).newHighWater).toBe(now.toISOString());
  });

  it('locks on a status of expired even when the date says otherwise', () => {
    // The server's own word outranks the arithmetic: a licence cancelled early
    // has a future expiry date and a status that says it is over.
    const result = evaluate(
      snapshot({ status: 'expired', expiresAt: '2030-01-01T00:00:00+00:00' }),
      now,
    );
    expect(result.state).toBe('LOCKED_EXPIRED');
  });
});

// -----------------------------------------------------------------------------
// Signatures that are the right shape and still wrong
// -----------------------------------------------------------------------------

describe('signature edges', () => {
  const keys = { k1: b64urlEncode(Buffer.alloc(32, 7)) };

  it('refuses a public key of the right length that is not on the curve', () => {
    // 32 bytes of the same byte is a valid length and not a valid point. Node
    // refuses it at key construction, and that has to surface as a
    // SignatureError rather than as whatever the crypto layer threw.
    expect(() =>
      verifyEnvelope(
        { alg: 'Ed25519', key_id: 'k1', payload: b64urlEncode(Buffer.from('{}')), signature: b64urlEncode(Buffer.alloc(64)) },
        keys,
      ),
    ).toThrow(SignatureError);
  });

  it('refuses an envelope whose payload is not JSON at all', () => {
    expect(() => peekClaims({ alg: 'Ed25519', key_id: 'k1', payload: 'not-base64-json', signature: '' })).not.toThrow();
    expect(peekClaims({ alg: 'Ed25519', key_id: 'k1', payload: 'zzzz', signature: '' })).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Keys
// -----------------------------------------------------------------------------

describe('key edges', () => {
  it('rejects a key containing a character outside the alphabet', () => {
    // checkSymbol throws for an unknown character; hasValidCheckSymbol has to
    // turn that into a plain false, because it is called on every keystroke.
    expect(hasValidCheckSymbol('AAAAI')).toBe(false);
  });

  it('rejects something too short to have a check symbol', () => {
    expect(hasValidCheckSymbol('')).toBe(false);
    expect(hasValidCheckSymbol('A')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Fingerprints
// -----------------------------------------------------------------------------

describe('fingerprint comparison', () => {
  it('reports zero rather than dividing by zero when nothing is comparable', () => {
    const result = compareComponents({}, {});
    expect(result.weight).toBe(0);
    expect(result.stability).toBe(0);
    expect(result.matched).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('counts a component missing on one side as neither a match nor a change', () => {
    // An older client version simply does not report everything, and punishing
    // that would make every upgrade look like a new machine.
    const result = compareComponents({ machine_id: 'a', board: 'b' }, { machine_id: 'a' });
    expect(result.matched).toEqual(['machine_id']);
    expect(result.changed).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Versions
// -----------------------------------------------------------------------------

describe('version helpers', () => {
  it('answers whether a string is a version at all', () => {
    expect(isValidVersion('1.2.3')).toBe(true);
    expect(isValidVersion('v2')).toBe(true);
    expect(isValidVersion('latest')).toBe(false);
    expect(isValidVersion(null)).toBe(false);
    expect(isValidVersion(undefined)).toBe(false);
  });

  it('refuses a non-string rather than coercing it', () => {
    // A version read out of JSON can be a number, and `String(2.1)` would parse
    // as 2.1.0 - which is a guess about a field somebody typed wrongly.
    expect(parseVersion(2 as unknown as string)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The abortable sleep
// -----------------------------------------------------------------------------

describe('delay', () => {
  it('resolves immediately for a wait of nothing', async () => {
    await expect(delay(0)).resolves.toBeUndefined();
    await expect(delay(-5)).resolves.toBeUndefined();
  });

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delay(10_000, controller.signal)).rejects.toBeDefined();
  });

  it('rejects when the signal aborts during the wait', async () => {
    const controller = new AbortController();
    const pending = delay(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it('resolves normally when nothing aborts', async () => {
    const controller = new AbortController();
    await expect(delay(1, controller.signal)).resolves.toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Storage
// -----------------------------------------------------------------------------

describe('FileStorage on a path it cannot read', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'licence-edges-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('answers null when the path is a directory rather than a file', async () => {
    // EISDIR, not ENOENT. Both mean "there is no cache here", and refusing to
    // start over a misconfigured path would be the wrong answer to either.
    const storage = new FileStorage(directory);
    expect(await storage.read()).toBeNull();
  });

  it('answers null for a file that vanished between checks', async () => {
    const path = join(directory, 'licence.bin');
    await writeFile(path, 'x');
    await rm(path);
    expect(await new FileStorage(path).read()).toBeNull();
  });

  it('overwrites an existing cache atomically', async () => {
    const path = join(directory, 'nested', 'licence.bin');
    const storage = new FileStorage(path);
    await storage.write(Buffer.from('first'));
    await storage.write(Buffer.from('second'));
    expect(Buffer.from((await storage.read())!).toString()).toBe('second');
  });

  it('clears a file that is not there without complaining', async () => {
    await expect(new FileStorage(join(directory, 'gone.bin')).clear()).resolves.toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Canonical JSON, at its edges
// -----------------------------------------------------------------------------

describe('canonical json edges', () => {
  it('refuses a value it cannot render identically in both editions', () => {
    expect(() => canonicalJson(1.5 as never)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.NaN as never)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY as never)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson((Number.MAX_SAFE_INTEGER + 2) as never)).toThrow(
      CanonicalJsonError,
    );
    expect(() => canonicalJson((() => 1) as never)).toThrow(CanonicalJsonError);
  });

  it('drops undefined members, which are a JavaScript idea and not a JSON one', () => {
    expect(canonicalJson({ a: 1, b: undefined } as never)).toBe('{"a":1}');
  });

  it('sorts by code point, not by UTF-16 code unit', () => {
    // The two orders differ for anything outside the basic plane, and Python
    // sorts by code point. Getting this wrong makes every signature over a
    // payload containing an emoji fail, on one platform only.
    expect(canonicalJson({ '\u{1F600}': 1, '＀': 2 } as never)).toBe(
      '{"＀":2,"\u{1F600}":1}',
    );
  });
});

// -----------------------------------------------------------------------------
// The last few branches, each of which only runs when something is already odd
// -----------------------------------------------------------------------------

describe('the remaining branches', () => {
  it('rejects a check symbol whose payload is outside the alphabet', () => {
    // Crockford base32 has no I. A key containing one has already been folded
    // by normaliseKey in the ordinary path - this is the raw call, where
    // checkSymbol throws and the answer still has to be a plain false, because
    // it runs on every keystroke.
    expect(hasValidCheckSymbol('AAIAA')).toBe(false);
  });

  it('treats a Retry-After of only whitespace as absent', () => {
    expect(parseRetryAfter('   ', Date.now())).toBeNull();
  });

  it('carries the abort reason through rather than inventing one', async () => {
    const controller = new AbortController();
    const reason = new Error('the user closed the window');
    const pending = delay(10_000, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('refuses to order something that is not a version', () => {
    expect(() => compareVersions('1.0.0', 'latest')).toThrow(TypeError);
    expect(() => compareVersions('latest', '1.0.0')).toThrow(TypeError);
  });

  it('answers zero stability when no component is worth anything', () => {
    // TOTAL_WEIGHT is a constant and never zero, so the guard is defensive -
    // but the shape it protects, dividing by a weight table that could be
    // emptied, is worth stating.
    expect(compareComponents({ unknown_thing: 'a' }, { unknown_thing: 'a' }).stability).toBe(0);
  });

  it('reads a successful answer that is not JSON as nothing', async () => {
    // A proxy that returns an HTML holding page with a 200 is the usual way
    // this happens. The caller gets a null rather than a parse error, and the
    // licence decision falls back to the cache.
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async () =>
        new Response('<html>captive portal</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })) as unknown as typeof fetch,
    });

    await expect(transport.request('/x')).resolves.toBeNull();
  });

  it('reads an empty successful body as nothing', async () => {
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    });

    await expect(transport.request('/x')).resolves.toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// The transport's own small decisions
// -----------------------------------------------------------------------------

describe('query strings', () => {
  function urlFor(query: Record<string, string | number | boolean | null | undefined>): string {
    let seen = '';
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async (input: RequestInfo | URL) => {
        seen = String(input);
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    return transport.request('/x', { query }).then(() => seen) as unknown as string;
  }

  it('leaves out the parameters with nothing to say', async () => {
    let seen = '';
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async (input: RequestInfo | URL) => {
        seen = String(input);
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await transport.request('/x', {
      query: { page: 1, empty: undefined, missing: null, flag: false },
    });

    // undefined and null are absent, not the strings "undefined" and "null" -
    // which is what a naive template would send, and what the server would then
    // reject as a bad integer.
    expect(seen).toBe('https://a.test/api/v1/x?page=1&flag=false');
    void urlFor;
  });

  it('adds no question mark when every parameter was left out', async () => {
    let seen = '';
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async (input: RequestInfo | URL) => {
        seen = String(input);
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await transport.request('/x', { query: { a: undefined, b: null } });

    expect(seen).toBe('https://a.test/api/v1/x');
  });

  it('adds none for a call with no query at all', async () => {
    let seen = '';
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async (input: RequestInfo | URL) => {
        seen = String(input);
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await transport.request('/x');

    expect(seen).toBe('https://a.test/api/v1/x');
  });
});

describe('transport construction', () => {
  it('takes its fetch from the positional argument or the options', async () => {
    // Both spellings exist because the options object was added later, and the
    // positional one is what every existing caller passes.
    let positional = 0;
    let fromOptions = 0;
    const a = new Transport('https://a.test/api/v1', (async () => {
      positional += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);
    const b = new Transport('https://a.test/api/v1', undefined, 15_000, {
      fetch: (async () => {
        fromOptions += 1;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await a.request('/x');
    await b.request('/x');

    expect(positional).toBe(1);
    expect(fromOptions).toBe(1);
  });

  it('uses the options timeout over the positional one', async () => {
    // The later spelling wins, or a caller that set both would silently get the
    // one it did not mean.
    let seenSignal: AbortSignal | undefined;
    const transport = new Transport('https://a.test/api/v1', undefined, 60_000, {
      timeoutMs: 1,
      // A fetch that respects the signal, as a real one does: without that this
      // would prove nothing, because the abort would have no effect to observe.
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
        seenSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }) as unknown as typeof fetch,
      retry: { attempts: 0, baseDelayMs: 0, maxDelayMs: 0, budgetMs: 1_000, maxRetryAfterMs: 0 },
    });

    // A 60-second positional timeout would leave this hanging; the 1 ms from
    // the options is what makes it come back at all.
    await expect(transport.request('/x')).rejects.toBeDefined();
    expect(seenSignal?.aborted).toBe(true);
  });
});

describe('a seat limit the server described badly', () => {
  it('still produces an error a dialog can render', async () => {
    // A 409 with the right code and no detail. Substituting an empty summary
    // keeps `error.seats.active_seats` an array, so the dialog renders "no
    // machines listed" rather than throwing on undefined.
    const transport = new Transport('https://a.test/api/v1', undefined, 1_000, {
      fetch: (async () =>
        new Response(
          JSON.stringify({ error: { code: 'SeatLimitReached', message: 'full' } }),
          { status: 409 },
        )) as unknown as typeof fetch,
    });

    const error = (await transport.request('/x').catch((caught: unknown) => caught)) as {
      seats: { seats: { total: number }; active_seats: unknown[] };
    };
    expect(error.seats.active_seats).toEqual([]);
    expect(error.seats.seats.total).toBe(0);
  });
});

describe('the default fetch', () => {
  it('falls back to the global one when none was given', async () => {
    // A Transport built with neither a positional fetch nor one in its options
    // uses globalThis.fetch, which is what every production caller relies on.
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await new Transport('https://a.test/api/v1').request('/x');
    } finally {
      globalThis.fetch = original;
    }
    expect(called).toBe(1);
  });
});
