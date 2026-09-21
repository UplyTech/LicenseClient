/**
 * Ed25519 verification of the server's licence envelope.
 *
 * The client only ever holds the public key. An HMAC would need a shared
 * secret, and anyone who unpacks an Electron bundle could then issue
 * themselves any licence they liked.
 *
 * The one detail that breaks implementations of this pattern: the signature
 * covers the base64url-**decoded** payload bytes, never a re-serialised
 * object. Verifying against re-serialised JSON works right up until the first
 * payload whose key order or unicode escaping differs, and then fails silently
 * for everyone.
 */

import { createPublicKey, verify, type KeyObject } from 'node:crypto';

import { SignatureError } from './errors.js';

export const ALGORITHM = 'Ed25519';

/**
 * DER SPKI header for a raw Ed25519 public key.
 *
 * Node's `createPublicKey` will not take 32 raw bytes, and the header is
 * constant, so prefixing it is fourteen bytes and no dependency.
 */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface SignedEnvelope {
  alg: string;
  key_id: string;
  payload: string;
  signature: string;
}

export function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function b64urlEncode(value: Buffer | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function publicKeyFrom(encoded: string): KeyObject {
  const raw = b64urlDecode(encoded);
  if (raw.length !== 32) {
    throw new SignatureError(`An Ed25519 public key is 32 bytes, got ${raw.length}`);
  }
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    // Unreachable today: Ed25519 accepts any 32 bytes as a public key
    // encoding, so this only runs if Node changes its mind about what it will
    // import. Kept because the alternative is a raw crypto error reaching an
    // application that catches SignatureError.
    /* v8 ignore start */
  } catch (cause) {
    throw new SignatureError(`Unusable licence signing public key: ${String(cause)}`);
  }
  /* v8 ignore stop */
}

/**
 * Verify an envelope against a map of `key_id -> public key`.
 *
 * The map is compiled into the application. Fetching the key at runtime would
 * let whoever is in the middle hand out their own, which is the whole thing
 * this is meant to prevent.
 */
export function verifyEnvelope(
  envelope: SignedEnvelope,
  publicKeys: Readonly<Record<string, string>>,
): Record<string, unknown> {
  if (envelope?.alg !== ALGORITHM) {
    throw new SignatureError(`Unsupported signature algorithm: ${String(envelope?.alg)}`);
  }

  const encodedPublic = publicKeys[envelope.key_id];
  if (encodedPublic === undefined) {
    // Never fall back to "try them all": an unknown key id means the client is
    // older than the rotation, and the right answer is to say so.
    throw new SignatureError(`Unknown signing key id: ${envelope.key_id}`);
  }

  const payloadBytes = b64urlDecode(envelope.payload);
  const signatureBytes = b64urlDecode(envelope.signature);

  if (signatureBytes.length !== 64) {
    throw new SignatureError('Licence signature has the wrong length');
  }

  const ok = verify(null, payloadBytes, publicKeyFrom(encodedPublic), signatureBytes);
  if (!ok) {
    throw new SignatureError('Licence signature does not match the payload');
  }

  try {
    const claims: unknown = JSON.parse(payloadBytes.toString('utf8'));
    if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
      throw new SignatureError('Signed payload is not a JSON object');
    }
    return claims as Record<string, unknown>;
    // Reaching this needs a valid Ed25519 signature over bytes that are not
    // JSON, which only the holder of the signing key can produce. It is the
    // difference between a server bug surfacing as a SignatureError and as a
    // raw SyntaxError in somebody's application.
    /* v8 ignore start */
  } catch (cause) {
    if (cause instanceof SignatureError) throw cause;
    throw new SignatureError('Signed payload is not valid JSON');
  }
  /* v8 ignore stop */
}

/** Read the claims without verifying anything. For diagnostics only. */
export function peekClaims(envelope: SignedEnvelope): Record<string, unknown> | null {
  try {
    return JSON.parse(b64urlDecode(envelope.payload).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
