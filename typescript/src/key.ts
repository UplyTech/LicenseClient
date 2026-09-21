/**
 * Licence key format, checked offline.
 *
 * Mirrors `app/core/license_keys.py` in the API. The point of doing this on the
 * client is that a typo is rejected without a round trip - and without an
 * endpoint that answers "no such key", which would be a key oracle for anyone
 * who wanted to enumerate them.
 *
 *     ULT-TPM-3F7K9-2QW8M-XZ4RB-W
 *     ^^^ ^^^ ^^^^^^^^^^^^^^^^^^ ^
 *     |   |   15 random symbols   check symbol
 *     |   product code
 *     brand prefix
 */

import { InvalidKeyError } from './errors.js';

/** Crockford base32: no I, L, O or U. */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ALPHABET_SIZE = ALPHABET.length;
export const BRAND_PREFIX = 'ULT';
export const BODY_SYMBOLS = 15;
export const GROUP_SIZE = 5;

const VALUES = new Map<string, number>(
  Array.from(ALPHABET, (character, index) => [character, index] as const),
);

/** What people actually type when reading a key off a screen. */
const CONFUSABLES: Record<string, string> = { I: '1', L: '1', O: '0', U: 'V' };

const ALPHANUMERIC = /[A-Z0-9]/;

/**
 * Fold a typed key into `<CODE><BODY><CHECK>`.
 *
 * The brand prefix is stripped rather than folded: `ULT` contains U and L,
 * which the alphabet deliberately excludes. It is decoration, carries no
 * information, and stays out of the checksum - so a key typed without it still
 * resolves to the same value.
 */
export function normaliseKey(raw: string): string {
  let compact = '';
  for (const character of raw.toUpperCase()) {
    if (ALPHANUMERIC.test(character)) compact += character;
  }
  if (compact.startsWith(BRAND_PREFIX)) {
    compact = compact.slice(BRAND_PREFIX.length);
  }
  let folded = '';
  for (const character of compact) {
    folded += CONFUSABLES[character] ?? character;
  }
  return folded;
}

/** Render the display form with its dashes. */
export function formatKey(productCode: string, body: string, check: string): string {
  const groups: string[] = [];
  for (let index = 0; index < body.length; index += GROUP_SIZE) {
    groups.push(body.slice(index, index + GROUP_SIZE));
  }
  return [BRAND_PREFIX, productCode, ...groups, check].join('-');
}

/**
 * Luhn mod 32 over the alphabet.
 *
 * Catches every single wrong character and most transpositions, which is what
 * actually happens when a key is read aloud or retyped.
 */
export function checkSymbol(payload: string): string {
  let total = 0;
  let factor = 2;
  for (let index = payload.length - 1; index >= 0; index -= 1) {
    const character = payload[index]!;
    const value = VALUES.get(character);
    if (value === undefined) {
      throw new InvalidKeyError(`Character '${character}' is not part of the key alphabet`);
    }
    let addend = factor * value;
    addend = Math.floor(addend / ALPHABET_SIZE) + (addend % ALPHABET_SIZE);
    total += addend;
    factor = factor === 2 ? 1 : 2;
  }
  const remainder = total % ALPHABET_SIZE;
  return ALPHABET[(ALPHABET_SIZE - remainder) % ALPHABET_SIZE]!;
}

export function hasValidCheckSymbol(normalised: string): boolean {
  if (normalised.length < 2) return false;
  try {
    return checkSymbol(normalised.slice(0, -1)) === normalised.slice(-1);
  } catch {
    return false;
  }
}

export interface ParsedKey {
  productCode: string;
  normalised: string;
}

/**
 * Validate a typed key.
 *
 * Throws {@link InvalidKeyError} for anything malformed, so an activation
 * dialog can say "that looks like a typo" the moment the field loses focus.
 */
export function parseKey(raw: string): ParsedKey {
  const normalised = normaliseKey(raw);

  if (normalised.length <= BODY_SYMBOLS + 1) {
    throw new InvalidKeyError('Key is too short');
  }

  const productCode = normalised.slice(0, normalised.length - BODY_SYMBOLS - 1);
  if (productCode.length < 1 || productCode.length > 4) {
    throw new InvalidKeyError('Key has an implausible product code length');
  }

  if (!hasValidCheckSymbol(normalised)) {
    throw new InvalidKeyError('Key check symbol does not match - likely a typo');
  }

  return { productCode, normalised };
}

/** True when the key is well formed. For live validation while typing. */
export function isValidKey(raw: string): boolean {
  try {
    parseKey(raw);
    return true;
  } catch {
    return false;
  }
}
