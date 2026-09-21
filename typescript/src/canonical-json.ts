/**
 * Deterministic JSON, byte-for-byte identical to the API's
 * `app/core/license_signing.py:canonical_json`.
 *
 * Keys sorted, no whitespace, unicode left as UTF-8. The shared vectors in
 * `shared/testcases/canonical-json.json` pin the exact output; if this file and
 * the Python edition ever disagree, every signature check silently fails and
 * nobody can tell why.
 */

import { CanonicalJsonError } from './errors.js';

/** A value this serialiser accepts. Floats are deliberately not in the list. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/**
 * Compare by code point, not by UTF-16 code unit.
 *
 * JavaScript's default string comparison walks code units, which sorts
 * characters outside the basic plane before U+FFFF. Python sorts by code
 * point. Without this the two editions produce different key orders for any
 * payload containing an emoji, and the difference only shows up in production.
 */
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const x = a[index]!.codePointAt(0)!;
    const y = b[index]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

function encodeValue(value: CanonicalValue, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'string':
      // JSON.stringify escapes exactly what Python escapes with
      // ensure_ascii=False: quote, backslash and the C0 controls. Everything
      // else, including non-ASCII, stays as it is.
      return JSON.stringify(value);

    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`${path}: NaN and Infinity are not JSON`);
      }
      if (!Number.isInteger(value)) {
        // Python renders 1.0, JavaScript renders 1, and no amount of care
        // reconciles that in general. Licence payloads never carry a float, so
        // refusing one here turns a silent signature failure into an error at
        // the point where the value was introduced.
        throw new CanonicalJsonError(
          `${path}: only integers are allowed, got ${value} - ` +
            'a float cannot be serialised identically in both editions',
        );
      }
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(
          `${path}: ${value} is beyond the safe integer range and would lose precision`,
        );
      }
      return String(value);

    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => encodeValue(item, `${path}[${index}]`)).join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, CanonicalValue>)
        // undefined is a JavaScript idea, not a JSON one. Dropping such keys
        // matches what an object literal with an optional field means.
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => compareCodePoints(a, b));
      const body = entries
        .map(([key, item]) => `${JSON.stringify(key)}:${encodeValue(item, `${path}.${key}`)}`)
        .join(',');
      return `{${body}}`;
    }

    default:
      throw new CanonicalJsonError(`${path}: ${typeof value} cannot be serialised`);
  }
}

/** Serialise to the canonical string form. */
export function canonicalJson(value: CanonicalValue): string {
  return encodeValue(value, '$');
}

/** Serialise to the canonical UTF-8 bytes - what actually gets signed. */
export function canonicalJsonBytes(value: CanonicalValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
