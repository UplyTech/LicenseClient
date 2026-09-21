"""The client against a stand-in server.

What is being checked here is the behaviour that decides whether a paying
customer can work: a copied cache, a flat network, an expired device token, a
revoked licence. Each of those has a right answer, and most licence systems get
at least one of them wrong.
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from uplytech_license import (
    ApiError,
    DeviceIdentity,
    LicenseClient,
    MemoryStorage,
    NetworkError,
    SeatLimitError,
    canonical_json_bytes,
)
from uplytech_license.signature import b64url_encode

VECTOR_DIR = Path(__file__).resolve().parents[2] / "shared" / "testcases"
SIGNATURES = json.loads((VECTOR_DIR / "signature.json").read_text(encoding="utf-8"))

FINGERPRINT = "0da041751176c4024de409802c69467bd2a47366c705815dc3acc5339b1a873d"
OTHER_FINGERPRINT = "48d8ad1cb89811574994f6ce5776f7b6ffedcc856241a48b9c1ba35903fbf2de"

NOW = datetime(2026, 3, 1, 9, 0, tzinfo=UTC)

# Matches TEST_PRIVATE_KEY in shared/scripts/generate_vectors.py. Test material
# only - it is checked into a repository, which disqualifies it.
TEST_PRIVATE_KEY = "cJ3aJ_6yBBqfzKQ9E-mFO-tLp-mCOm9AKKB7WmpTb2Q"


def sign(payload: dict[str, Any]) -> dict[str, str]:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from uplytech_license.signature import b64url_decode

    private = Ed25519PrivateKey.from_private_bytes(b64url_decode(TEST_PRIVATE_KEY))
    payload_bytes = canonical_json_bytes(payload)
    return {
        "alg": "Ed25519",
        "key_id": SIGNATURES["keyId"],
        "payload": b64url_encode(payload_bytes),
        "signature": b64url_encode(private.sign(payload_bytes)),
    }


def status_body(**overrides: Any) -> dict[str, Any]:
    body = {
        "license_id": "lic_2f8a1c",
        "product": "teampromanager",
        "type": "subscription",
        "status": "active",
        "tier": "pro",
        "features": ["teams", "tasks", "time_tracking"],
        "expires_at": "2026-12-31T23:59:59+00:00",
        "seats": {"total": 5, "used": 1, "available": 4},
        "seat_id": 42,
        "grace_period_days": 7,
        "offline_valid_until": "2026-03-08T09:00:00+00:00",
        "next_check_after": "2026-03-01T21:00:00+00:00",
        "max_version": None,
        "warnings": [],
    }
    body.update(overrides)
    return body


def activation_body(**overrides: Any) -> dict[str, Any]:
    body = {
        "device_access_token": "device-token-1",
        "device_refresh_token": "refresh-token-1",
        "expires_in": 86400,
        "seat_id": 42,
        "license": status_body(),
        # Unsigned: the signature path has its own tests, and mixing the two
        # would make this file test the wrong thing.
        "signed_license": None,
        "warnings": [],
    }
    body.update(overrides)
    return body


class FakeServer:
    """Records what was sent and answers from a queue per path."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.routes: dict[str, list[tuple[int, Any]]] = {}
        self.offline = False

    def on(self, path: str, *responses: tuple[int, Any]) -> None:
        self.routes[path] = list(responses)

    def send(
        self,
        method: str,
        url: str,
        body: bytes | None,
        headers: dict[str, str],
        timeout: float,
    ) -> tuple[int, str]:
        if self.offline:
            raise NetworkError("The licence server could not be reached")

        path = url.split("/api/v1", 1)[1]
        token = headers.get("Authorization", "").removeprefix("Bearer ") or None
        self.calls.append(
            {
                "path": path,
                "method": method,
                "body": json.loads(body) if body else None,
                "token": token,
            }
        )

        queued = self.routes.get(path)
        if not queued:
            return 404, json.dumps({"error": {"code": "NotFound", "message": "no route"}})
        # The last response repeats, so a test only describes what changes.
        status, payload = queued.pop(0) if len(queued) > 1 else queued[0]
        return status, "" if payload is None else json.dumps(payload)


def make_client(server: FakeServer, **overrides: Any) -> LicenseClient:
    kwargs: dict[str, Any] = {
        "api_base_url": "https://api.example.test",
        "product_slug": "teampromanager",
        "app_version": "2.0.0",
        "public_keys": {SIGNATURES["keyId"]: SIGNATURES["publicKey"]},
        "storage": MemoryStorage(),
        "device": DeviceIdentity(fingerprint=FINGERPRINT, components={"machine_id": "a" * 64}),
        "send": server.send,
        "now": lambda: NOW,
    }
    kwargs.update(overrides)
    return LicenseClient(**kwargs)


@pytest.fixture
def server() -> FakeServer:
    return FakeServer()


KEY = "ULT-TPM-3F7K9-2QW8M-XZ4RB-W"


# -----------------------------------------------------------------------------
# Activation
# -----------------------------------------------------------------------------


def test_activation_stores_a_sealed_cache(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    storage = MemoryStorage()
    client = make_client(server, storage=storage)

    result = client.activate(KEY)

    assert result.state == "ACTIVE"
    assert result.can_run is True
    assert client.has_feature("time_tracking") is True
    assert client.has_feature("sso") is False

    stored = storage.read()
    assert stored is not None
    # The cache must not be readable with a text editor: the tier and the
    # expiry are exactly what somebody would edit.
    assert b"teampromanager" not in stored


def test_only_hashed_components_leave_the_machine(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    make_client(server).activate(KEY)

    sent = server.calls[0]["body"]["device"]["components"]
    for value in sent.values():
        assert len(value) == 64
        assert all(character in "0123456789abcdef" for character in value)


def test_a_full_licence_names_the_machines(server: FakeServer) -> None:
    server.on(
        "/licenses/device/activate",
        (
            409,
            {
                "error": {
                    "code": "SeatLimitReached",
                    "message": "All 2 seats of this licence are in use",
                    "detail": {
                        "seats": {"total": 2, "used": 2, "available": 0},
                        "active_seats": [
                            {
                                "id": 7,
                                "device_name": "Laptop",
                                "platform": "win32",
                                "app_version": "2.0.0",
                                "status": "active",
                                "last_seen_at": "2026-02-28T10:00:00+00:00",
                                "activated_at": "2026-01-05T10:00:00+00:00",
                            }
                        ],
                    },
                }
            },
        ),
    )

    with pytest.raises(SeatLimitError) as info:
        make_client(server).activate(KEY)

    # Without the list the application can only say "contact support".
    assert info.value.seats["seats"]["total"] == 2
    assert info.value.seats["active_seats"][0]["device_name"] == "Laptop"


# -----------------------------------------------------------------------------
# Cache
# -----------------------------------------------------------------------------


def test_the_cache_survives_a_restart(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    storage = MemoryStorage()
    make_client(server, storage=storage).activate(KEY)

    restarted = make_client(server, storage=storage)
    assert restarted.load().state == "ACTIVE"
    assert restarted.has_feature("tasks") is True


def test_the_cache_does_not_open_on_another_machine(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    storage = MemoryStorage()
    make_client(server, storage=storage).activate(KEY)

    # The whole copy protection: the file was carried to a second computer.
    thief = make_client(
        server,
        storage=storage,
        device=DeviceIdentity(fingerprint=OTHER_FINGERPRINT, components={}),
    )
    assert thief.load().state == "NOT_ACTIVATED"


def test_a_damaged_cache_is_discarded_not_fatal(server: FakeServer) -> None:
    storage = MemoryStorage()
    storage.write(b"this is not even JSON")

    client = make_client(server, storage=storage)
    assert client.load().state == "NOT_ACTIVATED"
    # And it cleans up, so the same broken file is not re-read every start.
    assert storage.read() is None


def test_a_cache_from_a_future_version_is_discarded(server: FakeServer) -> None:
    storage = MemoryStorage()
    storage.write(json.dumps({"v": 99, "nonce": "", "ciphertext": ""}).encode())
    assert make_client(server, storage=storage).load().state == "NOT_ACTIVATED"


def test_a_sealed_but_nonsense_cache_is_discarded(server: FakeServer) -> None:
    from uplytech_license.crypto import seal_with_nonce

    nonce = bytes(range(12))
    sealed = seal_with_nonce(b"{}", FINGERPRINT, "teampromanager", nonce)
    storage = MemoryStorage()
    storage.write(
        json.dumps(
            {
                "v": 1,
                "alg": "AES-256-GCM",
                "nonce": base64.b64encode(nonce).decode(),
                "ciphertext": base64.b64encode(sealed).decode(),
            }
        ).encode()
    )
    # Decrypts, but does not contain what this version writes.
    assert make_client(server, storage=storage).load().state == "NOT_ACTIVATED"


# -----------------------------------------------------------------------------
# Heartbeat
# -----------------------------------------------------------------------------


def test_an_expired_device_token_is_refreshed_once(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on(
        "/licenses/device/heartbeat",
        (401, {"error": {"code": "Unauthorized", "message": "expired"}}),
        (200, status_body()),
    )
    server.on(
        "/licenses/device/token/refresh",
        (
            200,
            activation_body(
                device_access_token="device-token-2", device_refresh_token="refresh-token-2"
            ),
        ),
    )

    client = make_client(server)
    client.activate(KEY)
    assert client.heartbeat().state == "ACTIVE"

    refreshes = [c for c in server.calls if c["path"] == "/licenses/device/token/refresh"]
    assert len(refreshes) == 1
    beats = [c for c in server.calls if c["path"] == "/licenses/device/heartbeat"]
    # The retry has to carry the *new* token, not the one that just failed.
    assert beats[-1]["token"] == "device-token-2"


def test_it_gives_up_after_one_refresh(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on(
        "/licenses/device/heartbeat",
        (401, {"error": {"code": "Unauthorized", "message": "seat revoked"}}),
    )
    server.on(
        "/licenses/device/token/refresh",
        (200, activation_body(device_access_token="device-token-2")),
    )

    client = make_client(server)
    client.activate(KEY)
    with pytest.raises(ApiError):
        client.heartbeat()


def test_a_revocation_is_adopted(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on("/licenses/device/heartbeat", (200, status_body(status="revoked")))

    client = make_client(server)
    client.activate(KEY)
    assert client.heartbeat().state == "LOCKED_REVOKED"
    assert client.has_feature("tasks") is False


# -----------------------------------------------------------------------------
# ensure
# -----------------------------------------------------------------------------


def test_it_keeps_working_when_the_server_is_unreachable(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    storage = MemoryStorage()
    make_client(server, storage=storage).activate(KEY)

    server.offline = True
    # Two days later - past the check-in time, well inside the offline window.
    client = make_client(
        server, storage=storage, now=lambda: datetime(2026, 3, 3, 9, 0, tzinfo=UTC)
    )
    result = client.ensure()

    assert result.state == "ACTIVE"
    assert result.should_check_in is True


def test_it_locks_once_the_offline_window_ran_out(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    storage = MemoryStorage()
    make_client(server, storage=storage).activate(KEY)

    server.offline = True
    client = make_client(
        server, storage=storage, now=lambda: datetime(2026, 3, 10, 9, 0, tzinfo=UTC)
    )
    assert client.ensure().state == "LOCKED_OFFLINE"


def test_it_does_not_call_out_when_nothing_is_due(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    storage = MemoryStorage()
    make_client(server, storage=storage).activate(KEY)

    before = len(server.calls)
    make_client(server, storage=storage).ensure()
    assert len(server.calls) == before


def test_a_server_fault_is_treated_as_a_connection_problem(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on(
        "/licenses/device/heartbeat",
        (503, {"error": {"code": "ServiceUnavailable", "message": "maintenance"}}),
    )
    storage = MemoryStorage()
    make_client(server, storage=storage).activate(KEY)

    client = make_client(
        server, storage=storage, now=lambda: datetime(2026, 3, 3, 9, 0, tzinfo=UTC)
    )
    assert client.ensure().state == "ACTIVE"


def test_a_refusal_the_server_made_is_surfaced(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on(
        "/licenses/device/heartbeat",
        (403, {"error": {"code": "Forbidden", "message": "This licence has been revoked"}}),
    )
    storage = MemoryStorage()
    make_client(server, storage=storage).activate(KEY)

    client = make_client(
        server, storage=storage, now=lambda: datetime(2026, 3, 3, 9, 0, tzinfo=UTC)
    )
    with pytest.raises(ApiError):
        client.ensure()


# -----------------------------------------------------------------------------
# deactivate
# -----------------------------------------------------------------------------


def test_deactivate_frees_the_seat_and_forgets(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on("/licenses/device/deactivate", (204, None))

    storage = MemoryStorage()
    client = make_client(server, storage=storage)
    client.activate(KEY)
    client.deactivate()

    assert client.state == "NOT_ACTIVATED"
    assert storage.read() is None
    assert any(c["path"] == "/licenses/device/deactivate" for c in server.calls)


def test_deactivate_forgets_locally_even_when_offline(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    storage = MemoryStorage()
    client = make_client(server, storage=storage)
    client.activate(KEY)

    server.offline = True
    client.deactivate()

    # Telling the user the licence is removed and then keeping it would be
    # worse than the orphaned seat, which the server reclaims on its own.
    assert client.state == "NOT_ACTIVATED"
    assert storage.read() is None


# -----------------------------------------------------------------------------
# Trials and signatures
# -----------------------------------------------------------------------------


def test_a_trial_is_started_against_the_signed_in_user(server: FakeServer) -> None:
    server.on(
        "/licenses/device/trial",
        (201, activation_body(license=status_body(status="trialing", type="trial"))),
    )

    client = make_client(server)
    assert client.start_trial("user-access-token", email="a@example.test").state == "ACTIVE"

    call = next(c for c in server.calls if c["path"] == "/licenses/device/trial")
    assert call["token"] == "user-access-token"
    assert call["body"]["email"] == "a@example.test"


class SigningServer(FakeServer):
    """Signs its answer with the nonce it was handed, the way the API does."""

    def __init__(self, **claim_overrides: Any) -> None:
        super().__init__()
        self.claim_overrides = claim_overrides

    def send(
        self,
        method: str,
        url: str,
        body: bytes | None,
        headers: dict[str, str],
        timeout: float,
    ) -> tuple[int, str]:
        payload = json.loads(body) if body else {}
        claims = {
            "v": 1,
            "license_id": "lic_2f8a1c",
            "product": "teampromanager",
            "device_fingerprint": FINGERPRINT,
            "not_before": "2026-01-01T00:00:00+00:00",
            "nonce": payload.get("nonce"),
        }
        claims.update(self.claim_overrides)
        return 201, json.dumps(activation_body(signed_license=sign(claims)))


def test_a_correctly_signed_answer_is_accepted_and_kept() -> None:
    client = make_client(SigningServer())
    assert client.activate(KEY).state == "ACTIVE"
    # Kept so the signature can be re-checked at any later start-up.
    assert client.verify_cached_signature() is True
    assert client.snapshot is not None
    assert client.snapshot.not_before == "2026-01-01T00:00:00+00:00"


def test_an_answer_bound_to_another_machine_is_refused() -> None:
    client = make_client(SigningServer(device_fingerprint="b" * 64))
    with pytest.raises(Exception, match="issued for another machine"):
        client.activate(KEY)


def test_an_answer_for_another_product_is_refused() -> None:
    client = make_client(SigningServer(product="flashtrix"))
    with pytest.raises(Exception, match="is for 'flashtrix'"):
        client.activate(KEY)


def test_a_replayed_answer_is_refused() -> None:
    client = make_client(SigningServer(nonce="some-other-request"))
    with pytest.raises(Exception, match="answers a different request"):
        client.activate(KEY)


def test_an_unsigned_server_reports_no_cached_signature(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    client = make_client(server)
    client.activate(KEY)
    assert client.verify_cached_signature() is False


# -----------------------------------------------------------------------------
# Odds and ends
# -----------------------------------------------------------------------------


def test_warnings_are_passed_through_for_the_banner(server: FakeServer) -> None:
    server.on(
        "/licenses/device/activate",
        (
            201,
            activation_body(
                license=status_body(warnings=["expires_in_7_days"]), warnings=["vm_suspected"]
            ),
        ),
    )
    client = make_client(server)
    client.activate(KEY)
    assert client.snapshot is not None
    assert client.snapshot.warnings == ("expires_in_7_days", "vm_suspected")


@pytest.mark.parametrize(
    "raw",
    [
        "https://api.example.test",
        "https://api.example.test/",
        "https://api.example.test/v1",
        "https://api.example.test/api/v1",
        "https://api.example.test/api/v1/",
    ],
)
def test_the_base_url_is_normalised(server: FakeServer, raw: str) -> None:
    assert make_client(server, api_base_url=raw).api_base_url == (
        "https://api.example.test/api/v1"
    )


def test_a_client_with_no_cache_refuses_a_heartbeat(server: FakeServer) -> None:
    with pytest.raises(Exception, match="not activated"):
        make_client(server).heartbeat()


def test_a_client_with_no_cache_does_nothing(server: FakeServer) -> None:
    client = make_client(server)
    assert client.ensure().state == "NOT_ACTIVATED"
    client.deactivate()
    client.reset()
    assert server.calls == []


def test_a_network_failure_is_distinct_from_a_refusal(server: FakeServer) -> None:
    server.offline = True
    with pytest.raises(NetworkError):
        make_client(server).activate(KEY)
