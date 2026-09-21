/**
 * The local cache, sealed with a key derived from the device fingerprint.
 *
 * A cache file copied to another computer does not decrypt there. That is what
 * makes an offline licence non-transferable: the signed payload names the
 * machine, and the file that holds it cannot even be opened elsewhere.
 *
 * Nothing is stored to derive the key from - it comes back out of the hardware
 * on every start, so there is no key file to steal alongside the cache.
 */

import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

import { CacheError } from './errors.js';

export const CACHE_SALT = 'uplytech-license-cache';
export const CACHE_INFO_PREFIX = 'v1:';
export const CACHE_AAD_PREFIX = 'uplytech-license-cache-v1:';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * HKDF-SHA256 over the fingerprint.
 *
 * The product slug goes into the info string, so a FlashTrix cache cannot be
 * opened as a TeamProManager one on the same machine.
 */
export function deriveCacheKey(fingerprint: string, productSlug: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(fingerprint, 'utf8'),
      Buffer.from(CACHE_SALT, 'utf8'),
      Buffer.from(`${CACHE_INFO_PREFIX}${productSlug}`, 'utf8'),
      KEY_BYTES,
    ),
  );
}

function aad(productSlug: string): Buffer {
  return Buffer.from(`${CACHE_AAD_PREFIX}${productSlug}`, 'utf8');
}

/**
 * Encrypt with an explicit nonce.
 *
 * Only the tests call this - production always wants a fresh random nonce, and
 * reusing one under the same key is the way to lose everything AES-GCM gives
 * you. It exists because a fixed nonce is the only way to have reproducible
 * vectors.
 */
export function sealWithNonce(
  plaintext: Uint8Array,
  fingerprint: string,
  productSlug: string,
  nonce: Uint8Array,
): Buffer {
  if (nonce.length !== NONCE_BYTES) {
    throw new CacheError(`AES-GCM wants a ${NONCE_BYTES}-byte nonce, got ${nonce.length}`);
  }
  const cipher = createCipheriv('aes-256-gcm', deriveCacheKey(fingerprint, productSlug), nonce);
  cipher.setAAD(aad(productSlug));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  // Tag appended, matching what Python's AESGCM produces, so the two editions
  // can read each other's files.
  return Buffer.concat([body, cipher.getAuthTag()]);
}

/** Decrypt. Throws {@link CacheError} for anything that does not verify. */
export function open(
  ciphertext: Uint8Array,
  fingerprint: string,
  productSlug: string,
  nonce: Uint8Array,
): Buffer {
  if (ciphertext.length < TAG_BYTES) {
    throw new CacheError('Cache is too short to contain an authentication tag');
  }
  const buffer = Buffer.from(ciphertext);
  const body = buffer.subarray(0, buffer.length - TAG_BYTES);
  const tag = buffer.subarray(buffer.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveCacheKey(fingerprint, productSlug),
      Buffer.from(nonce),
    );
    decipher.setAAD(aad(productSlug));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // Deliberately no detail: whether the file was copied, tampered with or
    // simply truncated, the answer is the same and the caller discards it.
    throw new CacheError('Cache does not decrypt on this machine');
  }
}
