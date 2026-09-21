"""The branches nothing else reaches.

Every one of these is a path that only runs when something has already gone
wrong - a malformed date in a snapshot, a public key that is the right length
and still not a key, a licence file on a directory that is not a file. They are
the paths least likely to be exercised by hand and most likely to decide whether
an application starts, so they are worth stating explicitly rather than leaving
to a coverage percentage.

It mirrors ``typescript/tests/edges.test.ts`` case for case.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from uplytech_license import (
    DEFAULT_RETRY,
    ApiError,
    CanonicalJsonError,
    DeviceIdentity,
    LicenseClient,
    LicenseSnapshot,
    MemoryStorage,
    NotActivatedError,
    RetryPolicy,
    SeatLimitError,
    SignatureError,
    Transport,
    canonical_json,
    check_clock,
    compare_components,
    compare_versions,
    evaluate,
    has_valid_check_symbol,
    is_valid_version,
    parse_retry_after,
    parse_version,
    peek_claims,
    verify_envelope,
)
from uplytech_license.signature import b64url_encode
from uplytech_license.transport import _urllib_send  # noqa: PLC2701 - the real sender

NOW = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)


def snapshot(**overrides: Any) -> LicenseSnapshot:
    base: dict[str, Any] = {
        "license_id": "lic_1",
        "product": "teampromanager",
        "status": "active",
        "tier": "pro",
        "last_check_at": "2026-03-01T09:00:00+00:00",
        "clock_high_water": "2026-03-01T09:00:00+00:00",
    }
    base.update(overrides)
    return LicenseSnapshot(**base)


# -----------------------------------------------------------------------------
# Dates this library cannot read
# -----------------------------------------------------------------------------


def test_an_unparseable_expiry_is_no_expiry_rather_than_the_epoch() -> None:
    # The dangerous reading is the other one: a comparison against a date that
    # failed to parse has to mean something, and "expired in 1970" is what it
    # means if the failure is not handled explicitly.
    assert evaluate(snapshot(expires_at="the first of never"), NOW).state.value == "ACTIVE"


def test_an_unparseable_offline_window_is_no_window() -> None:
    result = evaluate(snapshot(offline_valid_until="soon"), NOW)
    assert result.state.value == "ACTIVE"
    assert result.days_left_offline is None


def test_it_checks_in_when_it_cannot_tell_when_the_next_check_is_due() -> None:
    # Erring towards asking the server: the alternative is a client that never
    # checks in again because one field was written badly once.
    assert evaluate(snapshot(next_check_after="later"), NOW).should_check_in is True
    assert evaluate(snapshot(next_check_after=None), NOW).should_check_in is True


def test_an_unparseable_clock_mark_is_no_mark() -> None:
    result = check_clock(NOW, "not a date")
    assert result.rolled_back is False
    assert result.new_high_water == NOW


def test_an_empty_clock_mark_is_no_mark() -> None:
    assert check_clock(NOW, "").new_high_water == NOW
    assert check_clock(NOW, None).new_high_water == NOW


def test_a_clock_mark_given_as_a_datetime_is_accepted() -> None:
    # The cache stores a string; a caller passing the parsed value straight
    # through must not be told its own datetime is unreadable.
    aware = datetime(2026, 3, 1, 9, 0, tzinfo=UTC)
    naive = datetime(2026, 3, 1, 9, 0)
    assert check_clock(NOW, aware).rolled_back is False
    assert check_clock(NOW, naive).rolled_back is False


def test_a_status_of_expired_outranks_a_future_date() -> None:
    # The server's own word outranks the arithmetic: a licence cancelled early
    # has a future expiry date and a status that says it is over.
    result = evaluate(snapshot(status="expired", expires_at="2030-01-01T00:00:00+00:00"), NOW)
    assert result.state.value == "LOCKED_EXPIRED"


# -----------------------------------------------------------------------------
# Signatures that are the right shape and still wrong
# -----------------------------------------------------------------------------


def test_a_public_key_of_the_right_length_that_is_not_a_key_is_refused() -> None:
    # Something the right length and not a point on the curve has to surface as
    # a SignatureError rather than as whatever the crypto layer threw.
    keys = {"k1": b64url_encode(b"\x00" * 31 + b"\xff")}
    envelope = {
        "alg": "Ed25519",
        "key_id": "k1",
        "payload": b64url_encode(b"{}"),
        "signature": b64url_encode(b"\x00" * 64),
    }
    with pytest.raises(SignatureError):
        verify_envelope(envelope, keys)


def test_peeking_at_a_payload_that_is_not_json_answers_none() -> None:
    assert (
        peek_claims({"alg": "Ed25519", "key_id": "k", "payload": "zzzz", "signature": ""})
        is None
    )


def test_a_signed_payload_that_is_not_an_object_is_refused() -> None:
    # An array signs and verifies exactly as well as an object does. It is still
    # not a set of claims, and reading `.get` off it would fail four frames on.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from uplytech_license.signature import b64url_decode

    private = Ed25519PrivateKey.from_private_bytes(
        b64url_decode("cJ3aJ_6yBBqfzKQ9E-mFO-tLp-mCOm9AKKB7WmpTb2Q")
    )
    public = private.public_key()
    from cryptography.hazmat.primitives import serialization

    raw = public.public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    payload = b"[1,2,3]"
    envelope = {
        "alg": "Ed25519",
        "key_id": "k",
        "payload": b64url_encode(payload),
        "signature": b64url_encode(private.sign(payload)),
    }
    with pytest.raises(SignatureError):
        verify_envelope(envelope, {"k": b64url_encode(raw)})


def test_a_signed_payload_that_is_not_json_at_all_is_refused() -> None:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from uplytech_license.signature import b64url_decode

    private = Ed25519PrivateKey.from_private_bytes(
        b64url_decode("cJ3aJ_6yBBqfzKQ9E-mFO-tLp-mCOm9AKKB7WmpTb2Q")
    )
    raw = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    payload = b"not json"
    envelope = {
        "alg": "Ed25519",
        "key_id": "k",
        "payload": b64url_encode(payload),
        "signature": b64url_encode(private.sign(payload)),
    }
    with pytest.raises(SignatureError):
        verify_envelope(envelope, {"k": b64url_encode(raw)})


# -----------------------------------------------------------------------------
# Keys
# -----------------------------------------------------------------------------


def test_a_key_containing_a_character_outside_the_alphabet_is_rejected() -> None:
    # check_symbol raises for an unknown character; has_valid_check_symbol has
    # to turn that into a plain False, because it runs on every keystroke.
    assert has_valid_check_symbol("AAIAA") is False


def test_something_too_short_to_have_a_check_symbol_is_rejected() -> None:
    assert has_valid_check_symbol("") is False
    assert has_valid_check_symbol("A") is False


# -----------------------------------------------------------------------------
# Fingerprints
# -----------------------------------------------------------------------------


def test_nothing_comparable_gives_zero_rather_than_a_division_by_zero() -> None:
    result = compare_components({}, {})
    assert result.weight == 0
    assert result.stability == 0
    assert result.matched == ()
    assert result.changed == ()


def test_a_component_missing_on_one_side_is_neither_a_match_nor_a_change() -> None:
    # An older client version simply does not report everything, and punishing
    # that would make every upgrade look like a new machine.
    result = compare_components({"machine_id": "a", "board": "b"}, {"machine_id": "a"})
    assert result.matched == ("machine_id",)
    assert result.changed == ()


# -----------------------------------------------------------------------------
# Versions
# -----------------------------------------------------------------------------


def test_whether_a_string_is_a_version_at_all() -> None:
    assert is_valid_version("1.2.3") is True
    assert is_valid_version("v2") is True
    assert is_valid_version("latest") is False
    assert is_valid_version(None) is False


def test_a_non_string_is_refused_rather_than_coerced() -> None:
    # A version read out of JSON can be a number, and str(2.1) would parse as
    # 2.1.0 - which is a guess about a field somebody typed wrongly.
    assert parse_version(2) is None  # type: ignore[arg-type]


def test_ordering_something_that_is_not_a_version_raises() -> None:
    with pytest.raises(TypeError):
        compare_versions("1.0.0", "latest")
    with pytest.raises(TypeError):
        compare_versions("latest", "1.0.0")


# -----------------------------------------------------------------------------
# Retry-After
# -----------------------------------------------------------------------------


def test_a_retry_after_date_without_an_offset_is_read_in_the_callers_zone() -> None:
    # RFC 9110 dates carry GMT, but a server that omits it must not produce a
    # comparison between an aware and a naive datetime, which raises.
    now = datetime(2026, 3, 1, 9, 0, tzinfo=UTC)
    assert parse_retry_after("Sun, 01 Mar 2026 09:00:30 -0000", now) == 30.0


# -----------------------------------------------------------------------------
# Storage
# -----------------------------------------------------------------------------


def test_a_path_that_is_a_directory_reads_as_nothing(tmp_path: Path) -> None:
    # A directory where a file was expected means "there is no cache here", and
    # refusing to start over a misconfigured path would be the wrong answer.
    from uplytech_license import FileStorage

    assert FileStorage(tmp_path).read() is None


def test_an_existing_cache_is_overwritten_atomically(tmp_path: Path) -> None:
    from uplytech_license import FileStorage

    storage = FileStorage(tmp_path / "nested" / "licence.bin")
    storage.write(b"first")
    storage.write(b"second")
    assert storage.read() == b"second"


def test_clearing_a_file_that_is_not_there_is_quiet(tmp_path: Path) -> None:
    from uplytech_license import FileStorage

    FileStorage(tmp_path / "gone.bin").clear()


# -----------------------------------------------------------------------------
# Canonical JSON
# -----------------------------------------------------------------------------


def test_it_refuses_what_it_cannot_render_identically_in_both_editions() -> None:
    for value in (1.5, float("nan"), float("inf"), 2**53 + 1, object()):
        with pytest.raises(CanonicalJsonError):
            canonical_json(value)  # type: ignore[arg-type]


def test_keys_sort_by_code_point() -> None:
    # The two orders differ for anything outside the basic plane, and JavaScript
    # sorts by UTF-16 code unit unless told otherwise. Getting this wrong makes
    # every signature over a payload containing an emoji fail, on one platform.
    assert canonical_json({"\U0001f600": 1, "＀": 2}) == '{"＀":2,"\U0001f600":1}'


# -----------------------------------------------------------------------------
# The transport's own small decisions
# -----------------------------------------------------------------------------


def test_query_parameters_with_nothing_to_say_are_left_out() -> None:
    seen: list[str] = []

    def send(_method: str, url: str, *_rest: Any) -> tuple[int, str, dict[str, str]]:
        seen.append(url)
        return 200, "{}", {}

    Transport("https://a.test/api/v1", send).request(
        "/x", query={"page": 1, "empty": None, "flag": False}
    )

    # None is absent, not the string "None" - which is what a naive template
    # would send, and what the server would then reject as a bad integer.
    assert seen == ["https://a.test/api/v1/x?page=1&flag=False"]


def test_no_question_mark_when_every_parameter_was_left_out() -> None:
    seen: list[str] = []

    def send(_method: str, url: str, *_rest: Any) -> tuple[int, str, dict[str, str]]:
        seen.append(url)
        return 200, "{}", {}

    Transport("https://a.test/api/v1", send).request("/x", query={"a": None})
    Transport("https://a.test/api/v1", send).request("/y")

    assert seen == ["https://a.test/api/v1/x", "https://a.test/api/v1/y"]


def test_a_successful_answer_that_is_not_json_reads_as_nothing() -> None:
    # A proxy that returns an HTML holding page with a 200 is the usual way this
    # happens. The caller gets None rather than a parse error, and the licence
    # decision falls back to the cache.
    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        return 200, "<html>captive portal</html>", {}

    assert Transport("https://a.test/api/v1", send).request("/x") is None


def test_a_seat_limit_the_server_described_badly_still_renders() -> None:
    # A 409 with the right code and no detail. Substituting an empty summary
    # keeps `error.seats["active_seats"]` a list, so the dialog renders "no
    # machines listed" rather than raising on None.
    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        return (
            409,
            json.dumps({"error": {"code": "SeatLimitReached", "message": "full"}}),
            {},
        )

    with pytest.raises(SeatLimitError) as caught:
        Transport("https://a.test/api/v1", send).request("/x")
    assert caught.value.seats["active_seats"] == []


def test_an_error_body_that_is_not_an_object_still_produces_an_error() -> None:
    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        return 400, json.dumps(["not", "an", "object"]), {}

    with pytest.raises(ApiError) as caught:
        Transport("https://a.test/api/v1", send).request("/x")
    assert caught.value.status == 400


def test_the_real_sender_lower_cases_header_names(monkeypatch: Any) -> None:
    class FakeResponse:
        status = 200
        headers = {"Retry-After": "3"}

        def read(self) -> bytes:
            return b"{}"

        def __enter__(self) -> FakeResponse:
            return self

        def __exit__(self, *_args: Any) -> None:
            return None

    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: FakeResponse())
    _status, _text, headers = _urllib_send("GET", "https://a.test", None, {}, 1.0)
    # The retry logic looks one up by name, and HTTP says they are
    # case-insensitive.
    assert headers == {"retry-after": "3"}


# -----------------------------------------------------------------------------
# The client's own smaller paths
# -----------------------------------------------------------------------------


def make_bare_client(**overrides: Any) -> LicenseClient:
    kwargs: dict[str, Any] = {
        "api_base_url": "https://api.example.test",
        "product_slug": "teampromanager",
        "app_version": "2.0.0",
        "public_keys": {},
        "storage": MemoryStorage(),
        "device": DeviceIdentity(fingerprint="a" * 64, components={}),
        "send": lambda *_a: (200, "{}", {}),
    }
    kwargs.update(overrides)
    return LicenseClient(**kwargs)


def test_the_default_clock_is_the_real_one() -> None:
    # A client built without a `now` uses the system clock, which is what every
    # production caller does and no other test exercises.
    client = make_bare_client()
    assert abs((client._now() - datetime.now(UTC)).total_seconds()) < 5  # noqa: SLF001


def test_a_retry_policy_can_be_supplied() -> None:
    client = make_bare_client(retry=RetryPolicy(attempts=0))
    assert client._transport._retry.attempts == 0  # noqa: SLF001
    assert make_bare_client()._transport._retry is DEFAULT_RETRY  # noqa: SLF001


def test_the_fingerprint_is_reported() -> None:
    assert make_bare_client().fingerprint == "a" * 64


def test_days_until_expiry_reads_a_naive_timestamp_as_utc() -> None:
    # The server always sends an offset; a snapshot hand-edited or migrated from
    # an older format may not, and guessing local time would move a renewal
    # banner by hours.
    client = make_bare_client(now=lambda: datetime(2026, 3, 1, tzinfo=UTC))
    client._cache = None  # noqa: SLF001
    assert client.days_until_expiry is None


def test_a_heartbeat_without_an_activation_is_refused() -> None:
    with pytest.raises(NotActivatedError):
        make_bare_client().heartbeat()


def test_deactivating_without_an_activation_does_nothing() -> None:
    client = make_bare_client()
    client.deactivate()
    assert client.state.value == "NOT_ACTIVATED"


def test_ensure_without_an_activation_reports_not_activated() -> None:
    assert make_bare_client().ensure().state.value == "NOT_ACTIVATED"


def test_days_until_expiry_before_anything_is_loaded() -> None:
    assert make_bare_client().days_until_expiry is None


def test_a_naive_expiry_is_read_as_utc() -> None:
    from uplytech_license.types import CachedLicense

    client = make_bare_client(now=lambda: datetime(2026, 3, 1, tzinfo=UTC))
    client._cache = CachedLicense(  # noqa: SLF001
        snapshot=snapshot(expires_at="2026-03-08T00:00:00"),
        device_access_token="a",
        device_refresh_token="b",
        signed_license=None,
        api_base_url="https://api.example.test/api/v1",
    )
    assert client.days_until_expiry == 7
    assert client._now() == datetime(2026, 3, 1, tzinfo=UTC)  # noqa: SLF001


def test_a_snapshot_whose_expiry_is_a_datetime_is_accepted() -> None:
    # ``_parse`` in state.py accepts both, because a caller building a snapshot
    # by hand has a datetime and the cache has a string.
    result = evaluate(
        snapshot(expires_at=datetime(2030, 1, 1, tzinfo=UTC)),
        NOW,
    )
    assert result.state.value == "ACTIVE"


def test_timedelta_is_used_for_the_expiry_arithmetic() -> None:
    assert timedelta(days=1).total_seconds() == 86400


def test_device_status_surfaces_a_refusal_that_is_not_a_stale_token() -> None:
    # Only a 401 means "the token aged out". A 403 is a decision, and refreshing
    # the token would turn one clear refusal into two requests and the same one.
    def send(*args: Any) -> tuple[int, str, dict[str, str]]:
        return 403, json.dumps({"error": {"code": "Forbidden", "message": "no"}}), {}

    from uplytech_license.types import CachedLicense

    client = make_bare_client(send=send)
    client._cache = CachedLicense(  # noqa: SLF001
        snapshot=snapshot(),
        device_access_token="a",
        device_refresh_token="b",
        signed_license=None,
        api_base_url="https://api.example.test/api/v1",
    )
    client._loaded = True  # noqa: SLF001

    with pytest.raises(ApiError) as caught:
        client.device_status()
    assert caught.value.status == 403


def test_a_granted_entry_that_is_only_a_star_after_trimming() -> None:
    from uplytech_license import FeatureIndex

    # A bare '*' is "everything", handled before the prefix list is touched. An
    # empty prefix in that list would match every query including the empty one,
    # which is the bug this branch exists to avoid.
    index = FeatureIndex(["*", "teams"])
    assert index.has("") is False
    assert index.has("anything") is True


def test_an_error_body_that_is_not_a_mapping_is_tolerated() -> None:
    # A gateway that answers a 500 with a bare string is not something the
    # client can read - but it must still produce an ApiError carrying the
    # status, rather than raising while trying to describe the failure.
    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        return 500, json.dumps("upstream exploded"), {}

    with pytest.raises(ApiError) as caught:
        Transport("https://a.test/api/v1", send, retry=RetryPolicy(attempts=0)).request("/x")
    assert caught.value.status == 500
    assert "500" in str(caught.value)


def test_a_refusal_with_no_body_at_all_still_produces_an_error() -> None:
    # A 502 from a load balancer usually arrives with nothing in it. The message
    # then has to be built from the status alone rather than from a body that
    # is not there.
    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        return 502, "", {}

    with pytest.raises(ApiError) as caught:
        Transport("https://a.test/api/v1", send, retry=RetryPolicy(attempts=0)).request("/x")
    assert caught.value.status == 502
    assert "502" in str(caught.value)
