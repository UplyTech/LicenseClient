/**
 * The contract between the TypeScript and the Python edition, and between both
 * of them and the API.
 *
 * These vectors live in `../../shared/testcases`. Four of them are generated
 * from the API's own modules, which is what makes this a contract rather than
 * a restatement of what this file happens to do. Never regenerate a vector to
 * make a test pass: if a vector changes, the wire format changed, and existing
 * installations stop working.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalJson, canonicalJsonBytes } from '../src/canonical-json.js';
import { deriveCacheKey, open, sealWithNonce } from '../src/crypto.js';
import { CacheError, InvalidKeyError } from '../src/errors.js';
import { hasFeature } from '../src/features.js';
import {
  COMPONENT_WEIGHTS,
  TOTAL_WEIGHT,
  combineFingerprint,
  compareComponents,
  hashComponent,
  hashComponents,
} from '../src/fingerprint.js';
import { checkSymbol, formatKey, normaliseKey, parseKey } from '../src/key.js';
import { verifyEnvelope, type SignedEnvelope } from '../src/signature.js';
import { compareVersions, parseVersion, versionWithin } from '../src/semver.js';
import { checkClock, evaluate } from '../src/state.js';
import type { LicenseSnapshot } from '../src/types.js';

const VECTOR_DIR = join(__dirname, '..', '..', 'shared', 'testcases');
const SUPPORTED_FORMAT_VERSION = 1;

function load<T = Record<string, unknown>>(name: string): T {
  const parsed = JSON.parse(readFileSync(join(VECTOR_DIR, `${name}.json`), 'utf8')) as {
    formatVersion: number;
  };
  expect(parsed.formatVersion, `${name}.json format version`).toBe(SUPPORTED_FORMAT_VERSION);
  return parsed as T;
}

// -----------------------------------------------------------------------------

describe('canonical json', () => {
  const vectors = load<{
    cases: { id: string; value: never; expect: string; expectBytesBase64: string }[];
  }>('canonical-json');

  it.each(vectors.cases.map((c) => [c.id, c] as const))('%s', (_id, testCase) => {
    expect(canonicalJson(testCase.value)).toBe(testCase.expect);
    expect(Buffer.from(canonicalJsonBytes(testCase.value)).toString('base64')).toBe(
      testCase.expectBytesBase64,
    );
  });

  it('refuses a float, rather than producing bytes Python would not', () => {
    // Python renders 1.0, JavaScript renders 1. Failing loudly here beats a
    // signature that silently stops verifying.
    expect(() => canonicalJson({ ratio: 0.5 } as never)).toThrow(/only integers/);
  });

  it('refuses NaN and Infinity', () => {
    expect(() => canonicalJson({ x: NaN } as never)).toThrow(/not JSON/);
    expect(() => canonicalJson({ x: Infinity } as never)).toThrow(/not JSON/);
  });

  it('drops undefined rather than writing it', () => {
    expect(canonicalJson({ a: 1, b: undefined } as never)).toBe('{"a":1}');
  });
});

// -----------------------------------------------------------------------------

describe('licence keys', () => {
  const vectors = load<{
    alphabet: string;
    brandPrefix: string;
    bodySymbols: number;
    validKeys: {
      id: string;
      productCode: string;
      body: string;
      checkSymbol: string;
      display: string;
      normalised: string;
    }[];
    normaliseCases: { id: string; input: string; expect: string }[];
    invalidKeys: { id: string; input: string; message: string }[];
  }>('key');

  it('agrees with the API on the alphabet', () => {
    expect(vectors.alphabet).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    // I, L, O and U are absent on purpose: the first three are confusable with
    // 1, 1 and 0, and U keeps a random key from spelling something unfortunate.
    for (const character of 'ILOU') {
      expect(vectors.alphabet).not.toContain(character);
    }
  });

  it.each(vectors.validKeys.map((k) => [k.id, k] as const))('accepts %s', (_id, key) => {
    expect(checkSymbol(`${key.productCode}${key.body}`)).toBe(key.checkSymbol);
    expect(formatKey(key.productCode, key.body, key.checkSymbol)).toBe(key.display);
    expect(parseKey(key.display)).toEqual({
      productCode: key.productCode,
      normalised: key.normalised,
    });
  });

  it.each(vectors.normaliseCases.map((c) => [c.id, c] as const))('normalises %s', (_id, c) => {
    expect(normaliseKey(c.input)).toBe(c.expect);
  });

  it.each(vectors.invalidKeys.map((c) => [c.id, c] as const))('rejects %s', (_id, c) => {
    expect(() => parseKey(c.input)).toThrow(InvalidKeyError);
    // The message is part of the contract: it is what the activation dialog
    // shows, and it must say "typo", not "unknown key".
    expect(() => parseKey(c.input)).toThrow(c.message);
  });
});

// -----------------------------------------------------------------------------

describe('signatures', () => {
  const vectors = load<{
    publicKey: string;
    keyId: string;
    valid: { envelope: SignedEnvelope; expectPayload: Record<string, unknown> };
    invalid: { id: string; envelope: SignedEnvelope }[];
  }>('signature');

  const keys = { [vectors.keyId]: vectors.publicKey };

  it('verifies a genuine envelope and returns its claims', () => {
    expect(verifyEnvelope(vectors.valid.envelope, keys)).toEqual(vectors.valid.expectPayload);
  });

  it.each(vectors.invalid.map((c) => [c.id, c.envelope] as const))(
    'refuses %s',
    (_id, envelope) => {
      expect(() => verifyEnvelope(envelope, keys)).toThrow();
    },
  );

  it('refuses an envelope when no key is known at all', () => {
    expect(() => verifyEnvelope(vectors.valid.envelope, {})).toThrow(/Unknown signing key id/);
  });
});

// -----------------------------------------------------------------------------

describe('cache encryption', () => {
  const vectors = load<{
    hkdfCases: {
      id: string;
      fingerprint: string;
      productSlug: string;
      expectKeyBase64: string;
    }[];
    sealCase: {
      fingerprint: string;
      productSlug: string;
      nonceBase64: string;
      plaintext: string;
      expectCiphertextBase64: string;
    };
    openFailures: {
      id: string;
      fingerprint: string;
      productSlug: string;
      nonceBase64: string;
      ciphertextBase64: string;
    }[];
  }>('crypto');

  it.each(vectors.hkdfCases.map((c) => [c.id, c] as const))('derives %s', (_id, c) => {
    expect(deriveCacheKey(c.fingerprint, c.productSlug).toString('base64')).toBe(
      c.expectKeyBase64,
    );
  });

  it('produces the ciphertext the Python edition produces', () => {
    const c = vectors.sealCase;
    const sealed = sealWithNonce(
      Buffer.from(c.plaintext, 'utf8'),
      c.fingerprint,
      c.productSlug,
      Buffer.from(c.nonceBase64, 'base64'),
    );
    expect(sealed.toString('base64')).toBe(c.expectCiphertextBase64);
  });

  it('reads back what it wrote', () => {
    const c = vectors.sealCase;
    const opened = open(
      Buffer.from(c.expectCiphertextBase64, 'base64'),
      c.fingerprint,
      c.productSlug,
      Buffer.from(c.nonceBase64, 'base64'),
    );
    expect(opened.toString('utf8')).toBe(c.plaintext);
  });

  it.each(vectors.openFailures.map((c) => [c.id, c] as const))('refuses %s', (_id, c) => {
    expect(() =>
      open(
        Buffer.from(c.ciphertextBase64, 'base64'),
        c.fingerprint,
        c.productSlug,
        Buffer.from(c.nonceBase64, 'base64'),
      ),
    ).toThrow(CacheError);
  });
});

// -----------------------------------------------------------------------------

describe('fingerprints', () => {
  const vectors = load<{
    weights: Record<string, number>;
    totalWeight: number;
    hashCases: { id: string; input: string; expect: string }[];
    combineCases: { id: string; components: Record<string, string>; expect: string }[];
    compareCases: {
      id: string;
      stored: Record<string, string>;
      presented: Record<string, string>;
      expect: { weight: number; matched: string[]; changed: string[] };
    }[];
  }>('fingerprint');

  it('uses the same weights as the server', () => {
    // If these drift, the client predicts a rebind the server will not make -
    // and the customer is told they kept a seat they actually lost.
    expect(COMPONENT_WEIGHTS).toEqual(vectors.weights);
    expect(TOTAL_WEIGHT).toBe(vectors.totalWeight);
  });

  it.each(vectors.hashCases.map((c) => [c.id, c] as const))('hashes %s', (_id, c) => {
    expect(hashComponent(c.input)).toBe(c.expect);
  });

  it.each(vectors.combineCases.map((c) => [c.id, c] as const))('combines %s', (_id, c) => {
    expect(combineFingerprint(hashComponents(c.components))).toBe(c.expect);
  });

  it.each(vectors.compareCases.map((c) => [c.id, c] as const))('compares %s', (_id, c) => {
    const match = compareComponents(c.stored, c.presented);
    expect(match.weight).toBe(c.expect.weight);
    expect(match.matched).toEqual(c.expect.matched);
    expect(match.changed).toEqual(c.expect.changed);
  });
});

// -----------------------------------------------------------------------------

describe('features', () => {
  const vectors = load<{
    cases: { id: string; granted: string[]; query: string; expect: boolean }[];
  }>('features');

  it.each(vectors.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(hasFeature(c.granted, c.query)).toBe(c.expect);
  });
});

// -----------------------------------------------------------------------------

interface StateCase {
  id: string;
  now: string;
  snapshot: Partial<LicenseSnapshot> | null;
  fingerprint?: string;
  appVersion?: string;
  expect: {
    state: string;
    reason: string | null;
    canRun: boolean;
    shouldCheckIn?: boolean;
  };
}

/**
 * Every field a snapshot has. Used to refuse a vector that names one it does
 * not - loudly, because silently ignoring an unknown key turns a typo in a
 * vector file into a green test. That is exactly how the update window's first
 * vectors "passed" against an evaluator that never saw a `maxVersion`.
 */
const SNAPSHOT_FIELDS: ReadonlySet<string> = new Set<keyof LicenseSnapshot>([
  'licenseId',
  'product',
  'type',
  'status',
  'tier',
  'features',
  'seatId',
  'deviceFingerprint',
  'notBefore',
  'expiresAt',
  'offlineValidUntil',
  'nextCheckAfter',
  'gracePeriodDays',
  'maxVersion',
  'lastCheckAt',
  'clockHighWater',
  'seats',
  'warnings',
]);

function runStateCase(c: StateCase): void {
  if (c.snapshot) {
    const unknown = Object.keys(c.snapshot).filter((key) => !SNAPSHOT_FIELDS.has(key));
    expect(unknown, `vector uses fields LicenseSnapshot does not have`).toEqual([]);
  }
  const result = evaluate(c.snapshot as LicenseSnapshot | null, new Date(c.now), {
    fingerprint: c.fingerprint ?? null,
    appVersion: c.appVersion ?? null,
  });
  expect(result.state).toBe(c.expect.state);
  expect(result.reason).toBe(c.expect.reason);
  expect(result.canRun).toBe(c.expect.canRun);
  if (c.expect.shouldCheckIn !== undefined) {
    expect(result.shouldCheckIn).toBe(c.expect.shouldCheckIn);
  }
}

describe('state machine', () => {
  const vectors = load<{ cases: StateCase[] }>('states');

  it.each(vectors.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    runStateCase(c);
  });
});

describe('clock', () => {
  const vectors = load<{
    toleranceHours: number;
    cases: {
      id: string;
      now: string;
      clockHighWater: string | null;
      expect: { rolledBack: boolean; newHighWater: string };
    }[];
    stateCases: StateCase[];
  }>('clock');

  it.each(vectors.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const result = checkClock(new Date(c.now), c.clockHighWater, vectors.toleranceHours);
    expect(result.rolledBack).toBe(c.expect.rolledBack);
    // Compared as instants: the vectors carry an offset, the result is UTC.
    expect(Date.parse(result.newHighWater)).toBe(Date.parse(c.expect.newHighWater));
  });

  it.each(vectors.stateCases.map((c) => [c.id, c] as const))('locks on %s', (_id, c) => {
    runStateCase(c);
  });
});

// -----------------------------------------------------------------------------

describe('version ordering', () => {
  const vectors = load<{
    compare: { id: string; left: string; right: string; expect: number }[];
    within: {
      id: string;
      appVersion: string | null;
      maxVersion: string | null;
      expect: boolean;
    }[];
    parse: {
      id: string;
      input: string;
      expect: { major: number; minor: number; patch: number; prerelease: (string | number)[] } | null;
    }[];
  }>('version');

  describe('compare', () => {
    it.each(vectors.compare.map((c) => [c.id, c] as const))('%s', (_id, c) => {
      expect(compareVersions(c.left, c.right)).toBe(c.expect);
      // Antisymmetry, for free, on every case: an implementation that gets the
      // ordering right in one direction and not the other is worse than one
      // that is wrong both ways, because half the comparisons look correct.
      // `|| 0` because negating zero in JavaScript gives -0, and vitest's
      // toBe uses Object.is, which tells the two apart.
      expect(compareVersions(c.right, c.left)).toBe(-c.expect || 0);
    });
  });

  describe('the update window', () => {
    it.each(vectors.within.map((c) => [c.id, c] as const))('%s', (_id, c) => {
      expect(versionWithin(c.appVersion, c.maxVersion)).toBe(c.expect);
    });
  });

  describe('parse', () => {
    it.each(vectors.parse.map((c) => [c.id, c] as const))('%s', (_id, c) => {
      const parsed = parseVersion(c.input);
      if (c.expect === null) {
        expect(parsed).toBeNull();
        return;
      }
      expect(parsed).not.toBeNull();
      expect(parsed!.major).toBe(c.expect.major);
      expect(parsed!.minor).toBe(c.expect.minor);
      expect(parsed!.patch).toBe(c.expect.patch);
      expect([...parsed!.prerelease]).toEqual(c.expect.prerelease);
    });
  });

  it('orders the whole SemVer example chain', () => {
    // The chain from the specification itself. Every adjacent pair is one rule,
    // and an implementation can satisfy each rule in isolation while composing
    // them wrongly - so the chain is checked as a chain.
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];
    for (let index = 0; index + 1 < chain.length; index += 1) {
      expect(
        compareVersions(chain[index]!, chain[index + 1]!),
        `${chain[index]} should order below ${chain[index + 1]}`,
      ).toBe(-1);
    }
    // And sorting the shuffled chain reproduces it, which catches a comparator
    // that is right pairwise but not transitive.
    const shuffled = [...chain].reverse();
    shuffled.sort(compareVersions);
    expect(shuffled).toEqual(chain);
  });
});
