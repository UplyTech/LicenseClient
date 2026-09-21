"""Generate the test vectors that cannot sensibly be written by hand.

Four of the eight vector files are cryptographic output: canonical JSON bytes,
licence key check symbols, Ed25519 envelopes and AES-GCM cache blobs. Nobody
can write those from memory, and a hand-typed digest that happens to be wrong
would make both editions agree on the wrong answer.

The other four files (``states``, ``clock``, ``features``, ``fingerprint``) are
hand written on purpose: they are the specification, not output. Generating
them from an implementation would only prove the implementation agrees with
itself.

The authority for the generated files is the API, not this package::

    cd Projekte/Intern/API
    ./.venv/Scripts/python.exe ../../Packages/LicenseClient/shared/scripts/generate_vectors.py

That import direction is deliberate. The server decides what a licence key
looks like and what it signs; the client library has to follow. Running this
against anything but the API's own modules would let the two drift apart
silently.

Regenerating is a deliberate act. If a vector changes, the wire format changed,
and that belongs in the changelog with a version bump. Never regenerate to make
a failing test pass.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from typing import Any

# Python puts the *script's* directory on sys.path, not the working directory,
# so running this from the API project would otherwise not find ``app``.
sys.path.insert(0, str(Path.cwd()))

try:
    from app.core.license_keys import (
        ALPHABET,
        BODY_SYMBOLS,
        BRAND_PREFIX,
        check_symbol,
        format_key,
        normalise_key,
        parse_key,
    )
    from app.core.license_signing import (
        b64url_encode,
        canonical_json,
        sign_license,
    )
except ModuleNotFoundError:  # pragma: no cover - operator error, not a code path
    sys.exit(
        "Run this from the API project so that 'app' is importable:\n"
        "  cd Projekte/Intern/API\n"
        "  ./.venv/Scripts/python.exe "
        "../../Packages/LicenseClient/shared/scripts/generate_vectors.py"
    )

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

OUT = Path(__file__).resolve().parents[1] / "testcases"

# A fixed key pair for the vectors. Test material, never used anywhere real -
# it is checked into a repository, which disqualifies it by definition.
TEST_PRIVATE_KEY = "cJ3aJ_6yBBqfzKQ9E-mFO-tLp-mCOm9AKKB7WmpTb2Q"
TEST_KEY_ID = "lk_test_2026"

CACHE_SALT = b"uplytech-license-cache"
CACHE_INFO_PREFIX = "v1:"
CACHE_AAD_PREFIX = "uplytech-license-cache-v1:"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def write(name: str, payload: dict[str, Any]) -> None:
    path = OUT / f"{name}.json"
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[+] {path.name}")


# -----------------------------------------------------------------------------
# canonical-json
# -----------------------------------------------------------------------------


def canonical_json_vectors() -> dict[str, Any]:
    cases: list[dict[str, Any]] = [
        {
            "id": "empty-object",
            "value": {},
        },
        {
            "id": "keys-are-sorted",
            "why": "Insertion order must not survive. This is the whole point of the format.",
            "value": {"b": 1, "a": 2, "c": 3},
        },
        {
            "id": "no-whitespace",
            "value": {"a": 1, "b": [1, 2, 3]},
        },
        {
            "id": "nested",
            "value": {"outer": {"z": 1, "a": {"y": 2, "b": 3}}},
        },
        {
            "id": "null-and-booleans",
            "why": "JSON null is not the empty string, and false is not 0.",
            "value": {"nothing": None, "yes": True, "no": False},
        },
        {
            "id": "empty-array-and-object",
            "value": {"list": [], "map": {}},
        },
        {
            "id": "unicode-is-not-escaped",
            "why": "ensure_ascii=False. The bytes carry UTF-8, not \\u sequences - "
            "the two editions would otherwise disagree on the escape casing.",
            "value": {"name": "Grüße", "emoji": "🔑"},
        },
        {
            "id": "key-sorting-is-by-code-point",
            "why": "JavaScript's default sort compares UTF-16 code units, which puts "
            "characters outside the basic plane in the wrong place. Python sorts by "
            "code point. The TypeScript edition has to sort by code point too.",
            "value": {"\U0001f511": 1, "￿": 2, "a": 3},
        },
        {
            "id": "characters-that-must-be-escaped",
            "why": "Quote, backslash and the control characters stay escaped even with "
            "ensure_ascii=False.",
            "value": {"quote": '"', "backslash": "\\", "newline": "\n", "tab": "\t"},
        },
        {
            "id": "integers-keep-their-shape",
            "value": {"zero": 0, "negative": -17, "big": 9007199254740991},
        },
        {
            "id": "a-realistic-licence-payload",
            "why": "The shape that is actually signed.",
            "value": {
                "v": 1,
                "license_id": "lic_2f8a1c",
                "product": "teampromanager",
                "product_id": 5,
                "subject": {"type": "tenant", "ref": "1"},
                "seat_id": 42,
                "device_fingerprint": "0da041751176c4024de409802c69467b"
                "d2a47366c705815dc3acc5339b1a873d",
                "type": "subscription",
                "tier": "pro",
                "status": "active",
                "features": ["teams", "tasks", "time_tracking"],
                "seat_limit": 5,
                "seats_used": 2,
                "issued_at": "2026-03-01T09:00:00+00:00",
                "not_before": "2026-01-01T00:00:00+00:00",
                "expires_at": "2026-12-31T23:59:59+00:00",
                "offline_valid_until": "2026-03-08T09:00:00+00:00",
                "grace_period_days": 7,
                "next_check_after": "2026-03-01T21:00:00+00:00",
                "max_version": None,
                "server_time": "2026-03-01T09:00:00+00:00",
                "nonce": "nonce-0123456789",
            },
        },
    ]

    for case in cases:
        encoded = canonical_json(case["value"])
        case["expect"] = encoded.decode("utf-8")
        case["expectBytesBase64"] = b64(encoded)

    return {
        "formatVersion": 1,
        "description": (
            "Deterministic JSON serialisation: keys sorted by code point, no whitespace, "
            "unicode left as UTF-8. Generated by app/core/license_signing.py:canonical_json "
            "in the API, which is the authority."
        ),
        "notes": [
            "Floating point numbers are deliberately absent, and both editions must "
            "refuse them. Python writes 1.0 where JavaScript writes 1, and no amount of "
            "care fixes that in general. Licence payloads only ever carry strings, "
            "integers, booleans, null, arrays and objects.",
            "The client never re-serialises a payload in order to verify it - it "
            "verifies the decoded bytes. This format exists so that both editions can "
            "produce a request body, a cache blob and a debugging dump that match.",
        ],
        "cases": cases,
    }


# -----------------------------------------------------------------------------
# key
# -----------------------------------------------------------------------------


#: A key whose body carries both 0 and 1, so folding O->0 and I->1 is testable.
CONFUSABLE_BODY = "01010101010101H"
CONFUSABLE_CODE = "TPM"


def _confusable_variant() -> str:
    """The confusable-key display form with 0 typed as O and 1 typed as I."""
    check = check_symbol(f"{CONFUSABLE_CODE}{CONFUSABLE_BODY}")
    display = format_key(CONFUSABLE_CODE, CONFUSABLE_BODY, check)
    # Only the body is rewritten; the brand prefix is stripped before folding
    # anyway, and mangling it would test the wrong thing.
    head, _, tail = display.partition(f"{BRAND_PREFIX}-{CONFUSABLE_CODE}-")
    return f"{head}{BRAND_PREFIX}-{CONFUSABLE_CODE}-" + tail.replace("0", "O").replace("1", "I")


def key_vectors() -> dict[str, Any]:
    valid = [
        ("TPM", "3F7K92QW8MXZ4RB"),
        ("TPM", "000000000000000"),
        ("FTX", "ZZZZZZZZZZZZZZZ"),
        ("VBT", "1234567890ABCDE"),
        ("WTG", "HJKMNPQRSTVWXYZ"),
        (CONFUSABLE_CODE, CONFUSABLE_BODY),
    ]
    valid_cases = []
    for code, body in valid:
        check = check_symbol(f"{code}{body}")
        display = format_key(code, body, check)
        valid_cases.append(
            {
                "id": f"{code}-{body[:5]}",
                "productCode": code,
                "body": body,
                "checkSymbol": check,
                "display": display,
                "normalised": f"{code}{body}{check}",
            }
        )

    reference = valid_cases[0]["display"]
    normalise_cases = [
        {"id": "already-canonical", "input": reference},
        {
            "id": "lower-case",
            "why": "Keys are read off a screen and typed back in.",
            "input": reference.lower(),
        },
        {
            "id": "spaces-instead-of-dashes",
            "input": reference.replace("-", " "),
        },
        {
            "id": "no-separators-at-all",
            "input": reference.replace("-", ""),
        },
        {
            "id": "without-the-brand-prefix",
            "why": "ULT is decoration. A key typed without it still resolves - the "
            "prefix contains U and L, which the alphabet excludes, so it is stripped "
            "rather than folded.",
            "input": reference[len(BRAND_PREFIX) + 1 :],
        },
        {
            "id": "confusable-letters",
            "why": "I and L read as 1, O as 0, U as V. Somebody reading a key aloud "
            "cannot get this wrong. Built from a key that actually contains 0 and 1, "
            "so the substitution has something to bite on.",
            "input": _confusable_variant(),
        },
        {
            "id": "surrounding-noise",
            "input": f"  {reference}\n",
        },
    ]
    for case in normalise_cases:
        case["expect"] = normalise_key(case["input"])

    invalid_cases = [
        {"id": "empty", "input": "", "why": "Nothing typed yet."},
        {"id": "too-short", "input": "ULT-TPM-3F7K9", "why": "A partially pasted key."},
        {
            "id": "one-wrong-character",
            "input": "ULT-TPM-3F7K9-2QW8M-XZ4RC-7",
            "why": "The single most common typo. The check symbol catches it offline, "
            "with no round trip and without telling anybody whether the key exists.",
        },
        {
            "id": "transposed-pair",
            "input": "ULT-TPM-3F7K9-2QW8M-XZ4BR-7",
            "why": "Two adjacent symbols swapped - the second most common typo.",
        },
        {
            "id": "wrong-check-symbol",
            "input": "ULT-TPM-3F7K9-2QW8M-XZ4RB-8",
            "why": "Body intact, check symbol changed.",
        },
        {
            "id": "body-too-long",
            "input": "ULT-TPM-3F7K9-2QW8M-XZ4RB-XX-7",
            "why": "A product code longer than four characters is implausible.",
        },
    ]
    for case in invalid_cases:
        try:
            parse_key(case["input"])
        except Exception as exc:  # noqa: BLE001 - recording the message is the point
            case["expectError"] = type(exc).__name__
            case["message"] = str(exc)
        else:  # pragma: no cover - would mean the format broke
            raise AssertionError(f"expected {case['id']!r} to be rejected")

    return {
        "formatVersion": 1,
        "description": (
            "Licence key format: Crockford base32 without I, L, O and U, fifteen body "
            "symbols and a Luhn mod 32 check symbol. Generated by "
            "app/core/license_keys.py in the API."
        ),
        "notes": [
            "The check symbol is what lets a client reject a typo without a network "
            "round trip - and without an endpoint that answers 'no such key', which "
            "would be a key oracle.",
            "The check symbol is computed over productCode + body, not over the "
            "display form: the brand prefix is stripped first.",
        ],
        "alphabet": ALPHABET,
        "brandPrefix": BRAND_PREFIX,
        "bodySymbols": BODY_SYMBOLS,
        "validKeys": valid_cases,
        "normaliseCases": normalise_cases,
        "invalidKeys": invalid_cases,
    }


# -----------------------------------------------------------------------------
# signature
# -----------------------------------------------------------------------------


def signature_vectors() -> dict[str, Any]:
    from app.core.license_signing import public_key_for

    public = public_key_for(TEST_PRIVATE_KEY)

    payload = {
        "v": 1,
        "license_id": "lic_2f8a1c",
        "product": "teampromanager",
        "tier": "pro",
        "status": "active",
        "features": ["teams", "tasks", "time_tracking"],
        "device_fingerprint": (
            "0da041751176c4024de409802c69467bd2a47366c705815dc3acc5339b1a873d"
        ),
        "expires_at": "2026-12-31T23:59:59+00:00",
        "offline_valid_until": "2026-03-08T09:00:00+00:00",
        "next_check_after": "2026-03-01T21:00:00+00:00",
        "grace_period_days": 7,
        "server_time": "2026-03-01T09:00:00+00:00",
        "nonce": "nonce-0123456789",
    }
    envelope = sign_license(payload, private_key=TEST_PRIVATE_KEY, key_id=TEST_KEY_ID).to_dict()

    tampered_payload = dict(payload, tier="enterprise")
    tampered = dict(envelope, payload=b64url_encode(canonical_json(tampered_payload)))

    other_envelope = sign_license(
        payload,
        # A second, unrelated key. Verifying against the first must fail.
        private_key="8bYCRVFVAO3vSlaXfeBSKEsBmzAaosyGZ_35VKnDlDA",
        key_id=TEST_KEY_ID,
    ).to_dict()

    return {
        "formatVersion": 1,
        "description": (
            "Ed25519 detached envelopes. The client holds only the public key; a shared "
            "secret would let anyone who unpacks the application issue themselves a licence."
        ),
        "notes": [
            "The signature covers the base64url-DECODED payload bytes. Verifying against "
            "a re-serialised object is the one mistake that breaks this pattern, and it "
            "breaks it silently.",
            "The public key is 32 raw bytes, base64url without padding. Node needs it "
            "wrapped in a DER SPKI header (302a300506032b6570032100) to build a KeyObject; "
            "that is fourteen bytes of prefix and no dependency.",
        ],
        "publicKey": public,
        "keyId": TEST_KEY_ID,
        "valid": {
            "id": "genuine-envelope",
            "envelope": envelope,
            "expectPayload": payload,
        },
        "invalid": [
            {
                "id": "tampered-payload",
                "why": "The tier was raised from pro to enterprise. Same signature, "
                "different payload.",
                "envelope": tampered,
            },
            {
                "id": "signed-by-another-key",
                "why": "A valid signature - by the wrong signer.",
                "envelope": other_envelope,
            },
            {
                "id": "unknown-key-id",
                "why": "A key id the client does not ship. Never guess; fail.",
                "envelope": dict(envelope, key_id="lk_someone_elses"),
            },
            {
                "id": "wrong-algorithm",
                "why": "An envelope claiming an algorithm this library does not implement "
                "must be refused, not ignored.",
                "envelope": dict(envelope, alg="HS256"),
            },
            {
                "id": "empty-signature",
                "envelope": dict(envelope, signature=""),
            },
            {
                "id": "payload-is-not-json",
                "envelope": dict(envelope, payload=b64url_encode(b"not json at all")),
            },
        ],
    }


# -----------------------------------------------------------------------------
# crypto
# -----------------------------------------------------------------------------


def derive_cache_key(fingerprint: str, product_slug: str) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=CACHE_SALT,
        info=f"{CACHE_INFO_PREFIX}{product_slug}".encode(),
    ).derive(fingerprint.encode())


def crypto_vectors() -> dict[str, Any]:
    fingerprint = "0da041751176c4024de409802c69467bd2a47366c705815dc3acc5339b1a873d"
    other_fingerprint = "48d8ad1cb89811574994f6ce5776f7b6ffedcc856241a48b9c1ba35903fbf2de"
    product = "teampromanager"

    key = derive_cache_key(fingerprint, product)
    nonce = bytes(range(12))
    plaintext = json.dumps({"status": "active", "tier": "pro"}, separators=(",", ":")).encode()
    aad = f"{CACHE_AAD_PREFIX}{product}".encode()
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, aad)

    return {
        "formatVersion": 1,
        "description": (
            "The local cache: AES-256-GCM with a key derived from the device "
            "fingerprint. A cache file copied to another computer does not decrypt "
            "there, which is what makes an offline licence non-transferable."
        ),
        "notes": [
            "HKDF-SHA256 over the fingerprint string, not over a stored key. There is "
            "nothing to steal from the file system.",
            "The product slug goes into both the HKDF info and the additional "
            "authenticated data, so a cache from one product cannot be replayed into "
            "another on the same machine.",
            "The nonce is random in production; these vectors pin a fixed one so the "
            "ciphertext is reproducible.",
            "A cache that fails to decrypt is discarded, never fatal. Corruption "
            "happens - a full disk, a killed process - and the right answer is to ask "
            "the server again, not to refuse to start.",
        ],
        "salt": CACHE_SALT.decode(),
        "infoPrefix": CACHE_INFO_PREFIX,
        "aadPrefix": CACHE_AAD_PREFIX,
        "hkdfCases": [
            {
                "id": "teampromanager",
                "fingerprint": fingerprint,
                "productSlug": product,
                "expectKeyBase64": b64(key),
            },
            {
                "id": "same-machine-other-product",
                "why": "Different info, different key - a FlashTrix cache cannot be "
                "read as a TeamProManager one.",
                "fingerprint": fingerprint,
                "productSlug": "flashtrix",
                "expectKeyBase64": b64(derive_cache_key(fingerprint, "flashtrix")),
            },
            {
                "id": "other-machine-same-product",
                "why": "This is the copy protection.",
                "fingerprint": other_fingerprint,
                "productSlug": product,
                "expectKeyBase64": b64(derive_cache_key(other_fingerprint, product)),
            },
        ],
        "sealCase": {
            "id": "round-trip",
            "fingerprint": fingerprint,
            "productSlug": product,
            "nonceBase64": b64(nonce),
            "plaintext": plaintext.decode(),
            "expectCiphertextBase64": b64(ciphertext),
        },
        "openFailures": [
            {
                "id": "wrong-machine",
                "why": "The file was copied. The tag does not verify.",
                "fingerprint": other_fingerprint,
                "productSlug": product,
                "nonceBase64": b64(nonce),
                "ciphertextBase64": b64(ciphertext),
            },
            {
                "id": "wrong-product",
                "fingerprint": fingerprint,
                "productSlug": "flashtrix",
                "nonceBase64": b64(nonce),
                "ciphertextBase64": b64(ciphertext),
            },
            {
                "id": "flipped-bit",
                "why": "One byte of the ciphertext changed.",
                "fingerprint": fingerprint,
                "productSlug": product,
                "nonceBase64": b64(nonce),
                "ciphertextBase64": b64(bytes([ciphertext[0] ^ 0x01]) + ciphertext[1:]),
            },
            {
                "id": "truncated",
                "why": "A half-written file after a power cut.",
                "fingerprint": fingerprint,
                "productSlug": product,
                "nonceBase64": b64(nonce),
                "ciphertextBase64": b64(ciphertext[:8]),
            },
        ],
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    write("canonical-json", canonical_json_vectors())
    write("key", key_vectors())
    write("signature", signature_vectors())
    write("crypto", crypto_vectors())
    print("\nHand written and not touched here: states, clock, features, fingerprint.")


if __name__ == "__main__":
    main()
