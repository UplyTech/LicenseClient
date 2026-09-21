"""Ed25519 verification of the server's licence envelope.

The client only ever holds the public key. An HMAC would need a shared secret,
and anyone who unpacked the application could then issue themselves any licence
they liked.

The one detail that breaks implementations of this pattern: the signature
covers the base64url-**decoded** payload bytes, never a re-serialised object.
Verifying against re-serialised JSON works right up until the first payload
whose key order or unicode escaping differs, and then fails silently for
everyone.
"""

from __future__ import annotations

import base64
import json
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .errors import SignatureError

ALGORITHM = "Ed25519"


def b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding)
    except Exception as exc:  # noqa: BLE001 - any malformed input means the same
        raise SignatureError(f"Not valid base64url: {exc}") from exc


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _public_key(encoded: str) -> Ed25519PublicKey:
    raw = b64url_decode(encoded)
    if len(raw) != 32:
        raise SignatureError(f"An Ed25519 public key is 32 bytes, got {len(raw)}")
    try:
        return Ed25519PublicKey.from_public_bytes(raw)
    # Unreachable today: Ed25519 accepts any 32 bytes as a public key encoding,
    # so this only runs if `cryptography` changes its mind about what it will
    # import. Kept because the alternative is a raw crypto error reaching an
    # application that catches SignatureError.
    except Exception as exc:  # noqa: BLE001 # pragma: no cover - see above
        raise SignatureError(f"Unusable licence signing public key: {exc}") from exc


def verify_envelope(
    envelope: dict[str, str] | None, public_keys: dict[str, str]
) -> dict[str, Any]:
    """Verify an envelope against a map of ``key_id -> public key``.

    The map is compiled into the application. Fetching the key at runtime would
    let whoever is in the middle hand out their own, which is the whole thing
    this is meant to prevent.
    """
    if not envelope or envelope.get("alg") != ALGORITHM:
        raise SignatureError(
            f"Unsupported signature algorithm: {(envelope or {}).get('alg')!r}"
        )

    key_id = envelope.get("key_id", "")
    encoded_public = public_keys.get(key_id)
    if encoded_public is None:
        # Never fall back to "try them all": an unknown key id means the client
        # is older than the rotation, and the right answer is to say so.
        raise SignatureError(f"Unknown signing key id: {key_id!r}")

    payload_bytes = b64url_decode(envelope.get("payload", ""))
    signature_bytes = b64url_decode(envelope.get("signature", ""))

    if len(signature_bytes) != 64:
        raise SignatureError("Licence signature has the wrong length")

    try:
        _public_key(encoded_public).verify(signature_bytes, payload_bytes)
    except InvalidSignature as exc:
        raise SignatureError("Licence signature does not match the payload") from exc

    try:
        claims = json.loads(payload_bytes)
    except ValueError as exc:
        raise SignatureError("Signed payload is not valid JSON") from exc

    if not isinstance(claims, dict):
        raise SignatureError("Signed payload is not a JSON object")
    return claims


def peek_claims(envelope: dict[str, str]) -> dict[str, Any] | None:
    """Read the claims without verifying anything. For diagnostics only."""
    try:
        claims = json.loads(b64url_decode(envelope.get("payload", "")))
    except (ValueError, SignatureError):
        return None
    return claims if isinstance(claims, dict) else None
