"""The local cache, sealed with a key derived from the device fingerprint.

A cache file copied to another computer does not decrypt there. That is what
makes an offline licence non-transferable: the signed payload names the
machine, and the file that holds it cannot even be opened elsewhere.

Nothing is stored to derive the key from - it comes back out of the hardware on
every start, so there is no key file to steal alongside the cache.
"""

from __future__ import annotations

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .errors import CacheError

CACHE_SALT = b"uplytech-license-cache"
CACHE_INFO_PREFIX = "v1:"
CACHE_AAD_PREFIX = "uplytech-license-cache-v1:"

KEY_BYTES = 32
NONCE_BYTES = 12
TAG_BYTES = 16


def derive_cache_key(fingerprint: str, product_slug: str) -> bytes:
    """HKDF-SHA256 over the fingerprint.

    The product slug goes into the info string, so a FlashTrix cache cannot be
    opened as a TeamProManager one on the same machine.
    """
    return HKDF(
        algorithm=hashes.SHA256(),
        length=KEY_BYTES,
        salt=CACHE_SALT,
        info=f"{CACHE_INFO_PREFIX}{product_slug}".encode(),
    ).derive(fingerprint.encode("utf-8"))


def _aad(product_slug: str) -> bytes:
    return f"{CACHE_AAD_PREFIX}{product_slug}".encode()


def seal_with_nonce(
    plaintext: bytes, fingerprint: str, product_slug: str, nonce: bytes
) -> bytes:
    """Encrypt with an explicit nonce.

    Only the tests and the vector generator call this - production always wants
    a fresh random nonce, and reusing one under the same key is the way to lose
    everything AES-GCM gives you. It exists because a fixed nonce is the only
    way to have reproducible vectors.
    """
    if len(nonce) != NONCE_BYTES:
        raise CacheError(f"AES-GCM wants a {NONCE_BYTES}-byte nonce, got {len(nonce)}")
    return AESGCM(derive_cache_key(fingerprint, product_slug)).encrypt(
        nonce, plaintext, _aad(product_slug)
    )


def open_sealed(ciphertext: bytes, fingerprint: str, product_slug: str, nonce: bytes) -> bytes:
    """Decrypt. Raises :class:`CacheError` for anything that does not verify."""
    if len(ciphertext) < TAG_BYTES:
        raise CacheError("Cache is too short to contain an authentication tag")
    try:
        return AESGCM(derive_cache_key(fingerprint, product_slug)).decrypt(
            nonce, ciphertext, _aad(product_slug)
        )
    except (InvalidTag, ValueError) as exc:
        # Deliberately no detail: whether the file was copied, tampered with or
        # simply truncated, the answer is the same and the caller discards it.
        raise CacheError("Cache does not decrypt on this machine") from exc
