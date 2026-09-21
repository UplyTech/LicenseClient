"""The corners the vector suite and the client suite do not reach: file
storage, the real HTTP sender, and the branches each module takes when it is
handed something malformed.
"""

from __future__ import annotations

import json
import os
import urllib.error
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from uplytech_license import (
    CachedLicense,
    CacheError,
    CanonicalJsonError,
    FileStorage,
    InvalidKeyError,
    LicenseSnapshot,
    NetworkError,
    SeatCounts,
    SignatureError,
    Transport,
    b64url_encode,
    canonical_json,
    check_symbol,
    evaluate,
    granted_from,
    has_feature,
    has_valid_check_symbol,
    is_valid_fingerprint,
    is_valid_key,
    normalise_api_url,
    open_sealed,
    parse_key,
    peek_claims,
    seal_with_nonce,
    verify_envelope,
)
from uplytech_license.fingerprint import FingerprintMatch
from uplytech_license.transport import _urllib_send

VECTOR_DIR = Path(__file__).resolve().parents[2] / "shared" / "testcases"
SIGNATURES = json.loads((VECTOR_DIR / "signature.json").read_text(encoding="utf-8"))
PUBLIC_KEYS = {SIGNATURES["keyId"]: SIGNATURES["publicKey"]}


# -----------------------------------------------------------------------------
# canonical json
# -----------------------------------------------------------------------------


def test_a_non_string_object_key_is_refused() -> None:
    with pytest.raises(CanonicalJsonError, match="keys must be strings"):
        canonical_json({1: "x"})


def test_a_type_json_cannot_hold_is_refused() -> None:
    with pytest.raises(CanonicalJsonError, match="cannot be serialised"):
        canonical_json({"when": datetime(2026, 1, 1, tzinfo=UTC)})


def test_top_level_values_serialise() -> None:
    assert canonical_json([3, 1, 2]) == "[3,1,2]"
    assert canonical_json(None) == "null"
    assert canonical_json("x") == '"x"'


def test_a_float_nested_in_a_list_is_still_caught() -> None:
    with pytest.raises(CanonicalJsonError, match=r"\$\.a\[1\]"):
        canonical_json({"a": [1, 0.5]})


# -----------------------------------------------------------------------------
# keys
# -----------------------------------------------------------------------------


def test_a_character_outside_the_alphabet_is_refused() -> None:
    # U is deliberately absent, so it cannot appear in a normalised key body.
    with pytest.raises(InvalidKeyError, match="not part of the key alphabet"):
        check_symbol("TPM!")


def test_a_one_character_input_has_no_check_symbol() -> None:
    assert has_valid_check_symbol("X") is False
    assert has_valid_check_symbol("") is False


def test_a_body_with_an_impossible_character_fails_the_check_not_the_alphabet() -> None:
    # normalise_key strips punctuation, so a '!' cannot survive - but a
    # character that is alphanumeric and still not in the alphabet can.
    assert has_valid_check_symbol("TPM3F7K92QW8MXZ4R!W") is False


def test_is_valid_key_never_raises() -> None:
    assert is_valid_key("ULT-TPM-3F7K9-2QW8M-XZ4RB-W") is True
    assert is_valid_key("ULT-TPM-3F7K9") is False
    assert is_valid_key("") is False


def test_a_product_code_longer_than_four_symbols_is_refused() -> None:
    with pytest.raises(InvalidKeyError, match="product code length"):
        parse_key("ULT-TOOLONG-3F7K9-2QW8M-XZ4RB-W")


# -----------------------------------------------------------------------------
# features and fingerprints
# -----------------------------------------------------------------------------


def test_granted_from_filters_a_wanted_list() -> None:
    assert granted_from(["teams", "export.*"], ["teams", "export.csv", "sso"]) == [
        "teams",
        "export.csv",
    ]


def test_a_bare_star_grants_everything() -> None:
    assert has_feature(["*"], "anything") is True


def test_fingerprint_validation() -> None:
    assert is_valid_fingerprint("a" * 64) is True
    assert is_valid_fingerprint("A" * 64) is False
    assert is_valid_fingerprint("a" * 63) is False


def test_stability_is_a_percentage_of_the_maximum() -> None:
    assert FingerprintMatch(weight=12, matched=(), changed=()).stability == 100
    assert FingerprintMatch(weight=6, matched=(), changed=()).stability == 50
    assert FingerprintMatch(weight=0, matched=(), changed=()).stability == 0


# -----------------------------------------------------------------------------
# crypto guards
# -----------------------------------------------------------------------------


def test_a_nonce_of_the_wrong_length_is_refused() -> None:
    with pytest.raises(CacheError, match="12-byte nonce"):
        seal_with_nonce(b"x", "f", "p", b"\x00" * 8)


def test_a_blob_shorter_than_the_tag_is_refused() -> None:
    with pytest.raises(CacheError, match="too short"):
        open_sealed(b"\x00" * 4, "f", "p", b"\x00" * 12)


# -----------------------------------------------------------------------------
# signatures
# -----------------------------------------------------------------------------


def test_a_public_key_that_is_not_32_bytes_is_refused() -> None:
    with pytest.raises(SignatureError, match="32 bytes"):
        verify_envelope(
            SIGNATURES["valid"]["envelope"],
            {SIGNATURES["keyId"]: b64url_encode(b"\x00" * 16)},
        )


def test_a_signature_of_the_wrong_length_is_refused() -> None:
    envelope = dict(SIGNATURES["valid"]["envelope"], signature=b64url_encode(b"\x00" * 10))
    with pytest.raises(SignatureError, match="wrong length"):
        verify_envelope(envelope, PUBLIC_KEYS)


def test_a_missing_envelope_is_refused() -> None:
    with pytest.raises(SignatureError, match="algorithm"):
        verify_envelope(None, PUBLIC_KEYS)


def test_peek_reads_claims_without_verifying_and_says_none_for_rubbish() -> None:
    claims = peek_claims(SIGNATURES["valid"]["envelope"])
    assert claims is not None
    assert claims["product"] == "teampromanager"
    assert peek_claims({"payload": b64url_encode(b"not json")}) is None
    assert peek_claims({"payload": b64url_encode(b"[1,2]")}) is None


def test_base64url_that_is_not_base64_is_refused() -> None:
    with pytest.raises(SignatureError, match="base64url"):
        verify_envelope(
            dict(SIGNATURES["valid"]["envelope"], payload="!!!not base64!!!"), PUBLIC_KEYS
        )


# -----------------------------------------------------------------------------
# state
# -----------------------------------------------------------------------------


def test_an_unparseable_date_is_treated_as_absent() -> None:
    snapshot = LicenseSnapshot(
        status="active",
        expires_at="not a date",
        offline_valid_until="also not a date",
        next_check_after=None,
        clock_high_water="",
    )
    result = evaluate(snapshot, datetime(2026, 3, 1, tzinfo=UTC))
    # Nothing readable to lock on, so it runs - and asks the server, because
    # next_check_after is missing.
    assert result.state == "ACTIVE"
    assert result.should_check_in is True
    assert result.days_left_offline is None


def test_a_naive_datetime_is_read_as_utc() -> None:
    snapshot = LicenseSnapshot(
        status="active",
        offline_valid_until="2026-03-08T09:00:00",
        next_check_after="2026-03-01T21:00:00",
        clock_high_water="2026-03-01T09:00:00",
    )
    assert evaluate(snapshot, datetime(2026, 3, 1, 9, tzinfo=UTC)).state == "ACTIVE"


def test_a_status_of_expired_locks_even_without_a_date() -> None:
    snapshot = LicenseSnapshot(status="expired", expires_at=None, clock_high_water="")
    assert evaluate(snapshot, datetime(2026, 3, 1, tzinfo=UTC)).state == "LOCKED_EXPIRED"


# -----------------------------------------------------------------------------
# types
# -----------------------------------------------------------------------------


def test_a_snapshot_round_trips_through_a_dict() -> None:
    snapshot = LicenseSnapshot(
        license_id="lic_1",
        features=("a", "b"),
        seats=SeatCounts(total=3, used=1, available=2),
    )
    restored = LicenseSnapshot.from_dict(snapshot.to_dict())
    assert restored == snapshot


def test_a_snapshot_ignores_fields_it_does_not_know() -> None:
    restored = LicenseSnapshot.from_dict({"license_id": "lic_1", "invented": 1, "seats": None})
    assert restored.license_id == "lic_1"
    assert restored.seats is None


def test_a_cached_licence_round_trips() -> None:
    cached = CachedLicense(
        snapshot=LicenseSnapshot(license_id="lic_1"),
        device_access_token="a",
        device_refresh_token="b",
        signed_license=None,
        api_base_url="https://a.test/api/v1",
    )
    assert CachedLicense.from_dict(cached.to_dict()) == cached


# -----------------------------------------------------------------------------
# transport
# -----------------------------------------------------------------------------


def test_every_spelling_a_settings_file_might_hold() -> None:
    assert normalise_api_url("  https://a.test//  ") == "https://a.test/api/v1"
    assert normalise_api_url("https://a.test/V1") == "https://a.test/api/v1"


def test_a_body_that_is_not_json() -> None:
    def send(*_args: Any) -> tuple[int, str]:
        return 504, "<html>gateway timeout</html>"

    with pytest.raises(Exception) as info:
        Transport("https://a.test/api/v1", send).request("/x")
    assert getattr(info.value, "status", None) == 504


def test_a_204_answers_none() -> None:
    def send(*_args: Any) -> tuple[int, str]:
        return 204, ""

    assert Transport("https://a.test/api/v1", send).request("/x") is None


def test_the_real_sender_turns_a_refusal_into_an_answer(monkeypatch: Any) -> None:
    class FakeHttpError(urllib.error.HTTPError):
        def __init__(self) -> None:
            super().__init__("https://a.test", 403, "Forbidden", {}, None)  # type: ignore[arg-type]

        def read(self) -> bytes:
            return b'{"error":{"code":"Forbidden","message":"no"}}'

    def raise_http_error(*_args: Any, **_kwargs: Any) -> None:
        raise FakeHttpError()

    monkeypatch.setattr("urllib.request.urlopen", raise_http_error)
    status, text, headers = _urllib_send("GET", "https://a.test", None, {}, 1.0)
    assert status == 403
    assert "Forbidden" in text
    # Headers come back even from a refusal, because that is where Retry-After
    # lives and a 429 is a refusal.
    assert isinstance(headers, dict)


def test_the_real_sender_turns_a_transport_failure_into_a_network_error(
    monkeypatch: Any,
) -> None:
    def raise_url_error(*_args: Any, **_kwargs: Any) -> None:
        raise urllib.error.URLError("no route to host")

    monkeypatch.setattr("urllib.request.urlopen", raise_url_error)
    with pytest.raises(NetworkError):
        _urllib_send("GET", "https://a.test", None, {}, 1.0)


def test_the_real_sender_reads_a_successful_answer(monkeypatch: Any) -> None:
    class FakeResponse:
        status = 200
        headers = {"Content-Type": "application/json", "Retry-After": "3"}

        def read(self) -> bytes:
            return b'{"ok":true}'

        def __enter__(self) -> FakeResponse:
            return self

        def __exit__(self, *_args: Any) -> None:
            return None

    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: FakeResponse())
    # Header names are lower-cased on the way out: HTTP says they are
    # case-insensitive, and the retry logic looks one up by name.
    assert _urllib_send("GET", "https://a.test", None, {}, 1.0) == (
        200,
        '{"ok":true}',
        {"content-type": "application/json", "retry-after": "3"},
    )


# -----------------------------------------------------------------------------
# FileStorage
# -----------------------------------------------------------------------------


def test_file_storage_answers_none_when_there_is_nothing(tmp_path: Path) -> None:
    assert FileStorage(tmp_path / "nested" / "licence.bin").read() is None


def test_file_storage_creates_the_directory_and_round_trips(tmp_path: Path) -> None:
    storage = FileStorage(tmp_path / "nested" / "licence.bin")
    storage.write(b"hello")
    assert storage.read() == b"hello"


def test_file_storage_leaves_no_temporary_file(tmp_path: Path) -> None:
    path = tmp_path / "licence.bin"
    FileStorage(path).write(b"hello")
    # The write goes to a temporary name and is renamed into place, so a power
    # cut halfway through cannot leave a truncated licence cache.
    assert list(tmp_path.iterdir()) == [path]


def test_file_storage_overwrites_rather_than_appending(tmp_path: Path) -> None:
    storage = FileStorage(tmp_path / "licence.bin")
    storage.write(b"first")
    storage.write(b"second")
    assert storage.read() == b"second"


def test_file_storage_clears_without_complaining(tmp_path: Path) -> None:
    storage = FileStorage(tmp_path / "licence.bin")
    storage.clear()
    storage.write(b"x")
    storage.clear()
    assert storage.read() is None


def test_file_storage_survives_a_chmod_the_platform_refuses(
    tmp_path: Path, monkeypatch: Any
) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise OSError("not supported here")

    monkeypatch.setattr(Path, "chmod", refuse)
    storage = FileStorage(tmp_path / "licence.bin")
    storage.write(b"x")
    assert storage.read() == b"x"


def test_file_storage_reads_none_when_the_path_is_a_directory(tmp_path: Path) -> None:
    assert FileStorage(tmp_path).read() is None
    assert os.path.isdir(tmp_path)
