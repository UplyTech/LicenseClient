"""The behaviour added after the first release, against the same stand-in server.

Everything here answers a question the original client could not: is this build
inside the licence's update window, can a customer free the seat their dead
laptop is holding, does a flaky connection cost a heartbeat, and does anybody
find out when the cache is silently discarded.

It mirrors ``typescript/tests/extended.test.ts`` case for case.
"""

from __future__ import annotations

import base64
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from uplytech_license import (
    NO_RETRY,
    ApiError,
    DeviceIdentity,
    FeatureIndex,
    LicenseClient,
    LicenseEvent,
    MemoryStorage,
    NetworkError,
    RateLimitError,
    RetryPolicy,
    Transport,
    ValidationError,
    backoff_seconds,
    canonical_json_bytes,
    is_retryable_status,
    parse_retry_after,
    seal_with_nonce,
)

VECTOR_DIR = Path(__file__).resolve().parents[2] / "shared" / "testcases"
SIGNATURES = json.loads((VECTOR_DIR / "signature.json").read_text(encoding="utf-8"))

FINGERPRINT = "0da041751176c4024de409802c69467bd2a47366c705815dc3acc5339b1a873d"
NOW = datetime(2026, 3, 1, 9, 0, tzinfo=UTC)
KEY = "ULT-TPM-3F7K9-2QW8M-XZ4RB-W"


def status_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
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
    body: dict[str, Any] = {
        "device_access_token": "device-token-1",
        "device_refresh_token": "refresh-token-1",
        "expires_in": 86400,
        "seat_id": 42,
        "license": status_body(),
        "signed_license": None,
        "warnings": [],
    }
    body.update(overrides)
    return body


class FakeServer:
    """Records what was sent and answers from a queue per path."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.routes: dict[str, list[tuple[int, Any, dict[str, str]]]] = {}
        self.offline = False
        #: How many transport failures to raise before answering normally.
        self.failures = 0

    def on(self, path: str, *responses: Any) -> None:
        normalised: list[tuple[int, Any, dict[str, str]]] = []
        for response in responses:
            if len(response) == 3:
                normalised.append(response)
            else:
                status, payload = response
                normalised.append((status, payload, {}))
        self.routes[path] = normalised

    def send(
        self,
        method: str,
        url: str,
        body: bytes | None,
        headers: dict[str, str],
        timeout: float,
    ) -> tuple[int, str, dict[str, str]]:
        if self.offline:
            raise NetworkError("The licence server could not be reached")
        if self.failures > 0:
            self.failures -= 1
            raise NetworkError("The licence server could not be reached")

        full = url.split("/api/v1", 1)[1]
        path = full.split("?", 1)[0]
        token = headers.get("Authorization", "").removeprefix("Bearer ") or None
        self.calls.append(
            {
                "path": full,
                "method": method,
                "body": json.loads(body) if body else None,
                "token": token,
            }
        )

        queued = self.routes.get(path)
        if not queued:
            return (
                404,
                json.dumps({"error": {"code": "NotFound", "message": "no route"}}),
                {},
            )
        status, payload, response_headers = queued.pop(0) if len(queued) > 1 else queued[0]
        return status, "" if payload is None else json.dumps(payload), response_headers


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


# -----------------------------------------------------------------------------
# The update window
# -----------------------------------------------------------------------------


def test_a_build_past_the_licence_max_version_is_locked(server: FakeServer) -> None:
    server.on(
        "/licenses/device/activate",
        (
            201,
            activation_body(
                license=status_body(type="perpetual", expires_at=None, max_version="1.9.0")
            ),
        ),
    )
    client = make_client(server, app_version="2.0.0")

    result = client.activate(KEY)

    assert result.state.value == "LOCKED_VERSION"
    assert result.reason == "version_not_covered"
    assert result.can_run is False
    # And the features go with it: an application that only checked has_feature
    # would otherwise keep working past the window it paid for.
    assert client.has_feature("time_tracking") is False
    assert client.version_covered is False


def test_the_exact_version_the_licence_names_is_allowed(server: FakeServer) -> None:
    server.on(
        "/licenses/device/activate",
        (
            201,
            activation_body(
                license=status_body(type="perpetual", expires_at=None, max_version="2.0.0")
            ),
        ),
    )
    client = make_client(server, app_version="2.0.0")

    assert client.activate(KEY).state.value == "ACTIVE"
    assert client.version_covered is True


def test_versions_are_not_compared_as_strings(server: FakeServer) -> None:
    # The whole reason semver.py exists: '1.10.0' < '1.9.0' as text.
    server.on(
        "/licenses/device/activate",
        (
            201,
            activation_body(
                license=status_body(type="perpetual", expires_at=None, max_version="1.9.0")
            ),
        ),
    )
    client = make_client(server, app_version="1.10.0")

    assert client.activate(KEY).state.value == "LOCKED_VERSION"


def test_a_revocation_outranks_the_update_window(server: FakeServer) -> None:
    server.on(
        "/licenses/device/activate",
        (
            201,
            activation_body(
                license=status_body(
                    status="revoked", type="perpetual", expires_at=None, max_version="1.0.0"
                )
            ),
        ),
    )
    client = make_client(server, app_version="9.0.0")

    # A revoked licence showing "please upgrade" would send the customer to buy
    # an upgrade for a licence that has been taken away.
    assert client.activate(KEY).state.value == "LOCKED_REVOKED"


# -----------------------------------------------------------------------------
# Retrying
# -----------------------------------------------------------------------------


def test_a_connection_that_drops_the_first_attempt_is_survived(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on("/licenses/device/heartbeat", (200, status_body()))
    client = make_client(
        server,
        now=lambda: datetime(2026, 3, 2, 9, 0, tzinfo=UTC),
    )
    client.activate(KEY)

    server.failures = 1
    assert client.heartbeat().can_run is True


def test_it_gives_up_after_the_policy_runs_out(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    client = make_client(server)
    client.activate(KEY)

    server.failures = 99
    with pytest.raises(NetworkError):
        client.heartbeat()


def test_a_503_is_retried_and_then_succeeds() -> None:
    calls = 0

    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return 503, "{}", {}
        return 200, json.dumps({"ok": True}), {}

    transport = Transport(
        "https://a.test/api/v1", send, sleep=lambda _s: None, random=lambda: 0.5
    )
    assert transport.request("/x") == {"ok": True}
    assert calls == 2


def test_a_decision_is_not_retried() -> None:
    # A 409 is an answer. Retrying it turns one seat-limit dialog into three.
    calls = 0

    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        nonlocal calls
        calls += 1
        return 409, json.dumps({"error": {"code": "Conflict", "message": "no"}}), {}

    transport = Transport("https://a.test/api/v1", send, sleep=lambda _s: None)
    with pytest.raises(ApiError):
        transport.request("/x")
    assert calls == 1


def test_retry_after_wins_over_the_computed_backoff() -> None:
    slept: list[float] = []
    calls = 0

    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return 429, "{}", {"retry-after": "2"}
        return 200, json.dumps({"ok": True}), {}

    transport = Transport(
        "https://a.test/api/v1", send, sleep=slept.append, random=lambda: 0.5
    )
    assert transport.request("/x") == {"ok": True}
    assert slept == [2.0]


def test_an_absurd_retry_after_is_not_sat_out() -> None:
    # A client blocked for an hour is worse than one that uses its cache.
    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        return (
            429,
            json.dumps({"error": {"code": "RateLimited", "message": "slow down"}}),
            {"retry-after": "3600"},
        )

    transport = Transport("https://a.test/api/v1", send, sleep=lambda _s: None)
    with pytest.raises(RateLimitError) as caught:
        transport.request("/x")
    assert caught.value.retry_after == 3600.0


def test_the_budget_stops_it_even_with_attempts_left() -> None:
    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        return 503, "{}", {}

    transport = Transport(
        "https://a.test/api/v1",
        send,
        # Every wait is longer than the whole budget.
        retry=RetryPolicy(attempts=5, base_delay=10.0, max_delay=10.0, budget=0.001),
        sleep=lambda _s: None,
        random=lambda: 1.0,
    )
    with pytest.raises(ApiError):
        transport.request("/x")


def test_nothing_is_retried_behind_an_activation_dialog() -> None:
    calls = 0

    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        nonlocal calls
        calls += 1
        return 503, "{}", {}

    transport = Transport("https://a.test/api/v1", send, sleep=lambda _s: None)
    with pytest.raises(ApiError):
        transport.request("/x", retry=NO_RETRY)
    assert calls == 1


@pytest.mark.parametrize("status", [408, 425, 429, 500, 502, 503, 504])
def test_transient_statuses_are_retryable(status: int) -> None:
    assert is_retryable_status(status) is True


@pytest.mark.parametrize("status", [200, 201, 204, 400, 401, 403, 404, 409, 422])
def test_decisions_are_not_retryable(status: int) -> None:
    assert is_retryable_status(status) is False


def test_retry_after_reads_seconds_and_dates() -> None:
    now = datetime(2026, 3, 1, 9, 0, tzinfo=UTC)
    assert parse_retry_after("5", now) == 5.0
    assert parse_retry_after("Sun, 01 Mar 2026 09:00:30 GMT", now) == 30.0
    # A date already past means "now", not a negative wait.
    assert parse_retry_after("Sun, 01 Mar 2026 08:59:00 GMT", now) == 0.0
    assert parse_retry_after("soon", now) is None
    assert parse_retry_after("   ", now) is None
    assert parse_retry_after("", now) is None
    assert parse_retry_after(None, now) is None


def test_backoff_spreads_retries_out_rather_than_lining_them_up() -> None:
    policy = RetryPolicy(attempts=3, base_delay=0.1, max_delay=1.0)
    # Full jitter: the wait is uniform in [0, cap), so the same attempt gives
    # different answers - which is the entire point of it.
    assert backoff_seconds(1, policy, lambda: 0.0) == 0.0
    assert backoff_seconds(1, policy, lambda: 1.0) == pytest.approx(0.1)
    assert backoff_seconds(2, policy, lambda: 0.5) == pytest.approx(0.1)
    assert backoff_seconds(3, policy, lambda: 1.0) == pytest.approx(0.4)
    # And the cap holds however far the exponent runs.
    assert backoff_seconds(20, policy, lambda: 1.0) == pytest.approx(1.0)


def test_a_sender_that_reports_no_headers_still_works() -> None:
    # The two-value shape predates retrying, and the bots that wrap this in an
    # executor were written against it.
    def send(*_args: Any) -> tuple[int, str]:
        return 200, json.dumps({"ok": True})

    assert Transport("https://a.test/api/v1", send).request("/x") == {"ok": True}


# -----------------------------------------------------------------------------
# Seats and owner-facing calls
# -----------------------------------------------------------------------------


def test_seats_can_be_listed(server: FakeServer) -> None:
    server.on(
        "/licenses/lic_2f8a1c/seats",
        (
            200,
            [
                {
                    "id": 42,
                    "device_name": "work-laptop",
                    "platform": "darwin",
                    "app_version": "2.0.0",
                    "status": "active",
                    "last_seen_at": "2026-03-01T08:00:00+00:00",
                    "activated_at": "2026-01-01T08:00:00+00:00",
                }
            ],
        ),
    )
    client = make_client(server)

    seats = client.list_seats("user-token", "lic_2f8a1c")

    assert len(seats) == 1
    assert seats[0]["device_name"] == "work-laptop"
    assert server.calls[0]["token"] == "user-token"


def test_a_seat_can_be_freed(server: FakeServer) -> None:
    server.on("/licenses/lic_2f8a1c/seats/42", (204, None))
    client = make_client(server)

    client.release_seat("user-token", "lic_2f8a1c", 42)

    assert server.calls[0]["method"] == "DELETE"
    assert server.calls[0]["path"] == "/licenses/lic_2f8a1c/seats/42"


def test_a_licence_id_is_escaped_rather_than_pasted_into_a_path(server: FakeServer) -> None:
    server.on("/licenses/a%2Fb/seats", (200, []))
    client = make_client(server)

    client.list_seats("t", "a/b")

    # Without encoding this would address /licenses/a/b/seats, which is a
    # different endpoint, and on a DELETE that matters rather more.
    assert server.calls[0]["path"] == "/licenses/a%2Fb/seats"


def test_licences_can_be_listed_with_paging(server: FakeServer) -> None:
    server.on("/licenses", (200, {"items": [], "total": 0, "page": 2, "page_size": 50}))
    client = make_client(server)

    page = client.list_licenses("user-token", 2, 50)

    assert page["page"] == 2
    assert server.calls[0]["path"] == "/licenses?page=2&page_size=50"


def test_one_licence_can_be_fetched(server: FakeServer) -> None:
    server.on("/licenses/lic_2f8a1c", (200, {"public_id": "lic_2f8a1c", "tier": "pro"}))
    client = make_client(server)

    assert client.get_license("user-token", "lic_2f8a1c")["public_id"] == "lic_2f8a1c"


def test_a_revealed_key_is_never_kept(server: FakeServer) -> None:
    server.on("/licenses/lic_2f8a1c/key", (200, {"license_key": KEY}))
    events: list[LicenseEvent] = []
    storage = MemoryStorage()
    client = make_client(server, storage=storage, on_event=events.append)

    assert client.reveal_key("user-token", "lic_2f8a1c") == KEY

    # Never written to the sealed file, never put into an event. A key that
    # leaks into a log is a key that has to be reissued.
    assert storage.read() is None
    assert "3F7K9" not in json.dumps([str(event) for event in events])


# -----------------------------------------------------------------------------
# Entitlement, for bots
# -----------------------------------------------------------------------------


def test_a_licensed_subject_is_reported(server: FakeServer) -> None:
    server.on(
        "/licenses/verify",
        (
            200,
            {
                "licensed": True,
                "tier": "pro",
                "features": ["filters"],
                "license_id": "lic_1",
                "expires_at": None,
                "subject": {"type": "discord_guild", "ref": "123"},
            },
        ),
    )
    client = make_client(server)

    answer = client.verify_subject("api-key", {"type": "discord_guild", "ref": "123"})

    assert answer.licensed is True
    assert answer.features == ("filters",)
    assert server.calls[0]["path"] == (
        "/licenses/verify?product_slug=teampromanager"
        "&subject_type=discord_guild&subject_ref=123"
    )


def test_an_unlicensed_subject_gets_the_free_tier(server: FakeServer) -> None:
    # A 200 rather than a 404, so a freemium product has one code path.
    server.on(
        "/licenses/verify",
        (
            200,
            {
                "licensed": False,
                "tier": "free",
                "features": ["basic"],
                "license_id": None,
                "expires_at": None,
                "subject": {"type": "discord_guild", "ref": "999"},
            },
        ),
    )
    client = make_client(server)

    answer = client.verify_subject("api-key", {"type": "discord_guild", "ref": "999"})

    assert answer.licensed is False
    assert answer.tier == "free"
    assert answer.features == ("basic",)


def test_a_hundred_guilds_in_one_round_trip(server: FakeServer) -> None:
    refs = [str(index) for index in range(100)]
    server.on(
        "/licenses/verify/bulk",
        (
            200,
            [
                {
                    "licensed": False,
                    "tier": "free",
                    "features": [],
                    "license_id": None,
                    "expires_at": None,
                    "subject": {"type": "discord_guild", "ref": ref},
                }
                for ref in refs
            ],
        ),
    )
    client = make_client(server)

    answers = client.verify_subjects("api-key", refs)

    assert len(answers) == 100
    assert len(server.calls) == 1


def test_more_than_the_server_accepts_is_refused_without_sending(server: FakeServer) -> None:
    client = make_client(server)

    with pytest.raises(ValidationError):
        client.verify_subjects("api-key", [str(index) for index in range(101)])
    assert server.calls == []


def test_an_empty_list_sends_nothing(server: FakeServer) -> None:
    client = make_client(server)
    assert client.verify_subjects("api-key", []) == []
    assert server.calls == []


# -----------------------------------------------------------------------------
# A read that does not write
# -----------------------------------------------------------------------------


def test_device_status_reads_without_adopting(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on("/licenses/device/status", (200, status_body(status="suspended")))
    client = make_client(server)
    client.activate(KEY)

    status = client.device_status()

    assert status["status"] == "suspended"
    # The cached decision is untouched: this is a read for a diagnostics screen,
    # and a "check now" button that quietly extended the offline window it was
    # reporting on would be worse than no button.
    assert client.state.value == "ACTIVE"
    assert server.calls[-1]["method"] == "GET"


def test_device_status_refreshes_a_stale_token_once(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on(
        "/licenses/device/status",
        (401, {"error": {"code": "Unauthorized", "message": "stale"}}),
        (200, status_body()),
    )
    server.on(
        "/licenses/device/token/refresh",
        (200, activation_body(device_access_token="device-token-2")),
    )
    client = make_client(server)
    client.activate(KEY)

    client.device_status()

    assert server.calls[-1]["token"] == "device-token-2"


def test_device_status_needs_an_activation(server: FakeServer) -> None:
    from uplytech_license import NotActivatedError

    client = make_client(server)
    with pytest.raises(NotActivatedError):
        client.device_status()


# -----------------------------------------------------------------------------
# Concurrency
# -----------------------------------------------------------------------------


def test_three_threads_calling_ensure_make_one_heartbeat(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on("/licenses/device/heartbeat", (200, status_body()))

    inside = threading.Event()
    release = threading.Event()

    def gated_send(*args: Any) -> Any:
        # Gates heartbeats only, so the activation below is not held up.
        if "/heartbeat" in args[1]:
            inside.set()
            release.wait(timeout=5)
        return server.send(*args)

    client = make_client(
        server, now=lambda: datetime(2026, 3, 2, 9, 0, tzinfo=UTC), send=gated_send
    )
    client.activate(KEY)
    before = len(server.calls)

    # The calls have to genuinely overlap or this measures nothing. A barrier
    # before ``ensure`` is not enough: against an instant fake server the first
    # thread finishes the whole check-in before the second one is scheduled, and
    # three *sequential* check-ins is the correct answer to that.
    #
    # So the first request is held open inside the server until the other two
    # threads have had time to arrive and park on the lock. That is the shape of
    # the real thing - a heartbeat takes a round trip, and the other callers turn
    # up during it.
    threads = [threading.Thread(target=client.ensure) for _ in range(3)]
    threads[0].start()
    assert inside.wait(timeout=5), "the first heartbeat never reached the server"
    for thread in threads[1:]:
        thread.start()
    # Long enough for two threads to reach the lock and block on it.
    time.sleep(0.2)
    release.set()
    for thread in threads:
        thread.join(timeout=10)

    # A bot's scheduler and its command handler both call this. Without the
    # guard they are three round trips, three nonces and three cache writes
    # racing to be last.
    assert len(server.calls) - before == 1


def test_a_later_call_checks_in_again(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on("/licenses/device/heartbeat", (200, status_body()))
    client = make_client(server, now=lambda: datetime(2026, 3, 2, 9, 0, tzinfo=UTC))
    client.activate(KEY)
    before = len(server.calls)

    client.ensure()
    client.ensure()

    # Sequential, not concurrent: the lock must not turn into a cache.
    assert len(server.calls) - before == 2


# -----------------------------------------------------------------------------
# Events
# -----------------------------------------------------------------------------


def test_a_discarded_cache_says_why(server: FakeServer) -> None:
    events: list[LicenseEvent] = []
    storage = MemoryStorage()
    storage.write(b"not json at all")
    client = make_client(server, storage=storage, on_event=events.append)

    client.load()

    discarded = [event for event in events if event.type == "cache.discarded"]
    assert discarded
    # The caller still sees the ordinary answer; the event is the only place the
    # reason exists at all.
    assert client.state.value == "NOT_ACTIVATED"


def test_a_cache_from_another_machine_is_named_as_such(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    storage = MemoryStorage()
    make_client(server, storage=storage).activate(KEY)

    events: list[LicenseEvent] = []
    elsewhere = make_client(
        server,
        storage=storage,
        device=DeviceIdentity(fingerprint="b" * 64, components={}),
        on_event=events.append,
    )
    elsewhere.load()

    discarded = next(event for event in events if event.type == "cache.discarded")
    assert discarded.data["reason"] == "wrong-machine"


def test_a_retry_is_reported() -> None:
    events: list[LicenseEvent] = []
    calls = 0

    def send(*_args: Any) -> tuple[int, str, dict[str, str]]:
        nonlocal calls
        calls += 1
        return (503 if calls == 1 else 200), "{}", {}

    Transport(
        "https://a.test/api/v1",
        send,
        sleep=lambda _s: None,
        random=lambda: 0.5,
        on_event=events.append,
    ).request("/x")

    assert any(event.type == "request.retry" for event in events)


def test_a_listener_that_raises_does_not_break_anything(server: FakeServer) -> None:
    # Observability is never allowed to be the thing that stops an application
    # starting.
    def explode(_event: LicenseEvent) -> None:
        raise RuntimeError("the log handler exploded")

    client = make_client(server, on_event=explode)
    assert client.load() is not None


def test_an_event_renders_as_a_log_line() -> None:
    assert str(LicenseEvent("cache.missing")) == "cache.missing"
    assert str(LicenseEvent("request.retry", {"attempt": 1})) == "request.retry attempt=1"


# -----------------------------------------------------------------------------
# The clock mark
# -----------------------------------------------------------------------------


def test_the_clock_mark_moves_forward_on_a_plain_start(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    storage = MemoryStorage()
    make_client(server, storage=storage).activate(KEY)

    # Four days later, still offline: no heartbeat, only a start-up.
    friday = datetime(2026, 3, 5, 9, 0, tzinfo=UTC)
    later = make_client(server, storage=storage, now=lambda: friday)
    later.load()

    assert later.snapshot is not None
    assert later.snapshot.clock_high_water == friday.isoformat()


def test_winding_the_clock_back_after_that_locks(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    storage = MemoryStorage()
    make_client(server, storage=storage).activate(KEY)
    make_client(
        server, storage=storage, now=lambda: datetime(2026, 3, 5, 9, 0, tzinfo=UTC)
    ).load()

    # Without the mark advancing on load, Monday's value would still be stored
    # and this would look like an ordinary Monday.
    wound = make_client(server, storage=storage, now=lambda: NOW)
    assert wound.load().state.value == "LOCKED_CLOCK"


def test_the_clock_mark_never_moves_backwards(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    storage = MemoryStorage()
    friday = datetime(2026, 3, 5, 9, 0, tzinfo=UTC)
    make_client(server, storage=storage, now=lambda: friday).activate(KEY)

    # An hour earlier - inside the tolerance, so not a lock, and the mark must
    # still not go down.
    earlier = make_client(server, storage=storage, now=lambda: friday - timedelta(hours=1))
    earlier.load()

    assert earlier.snapshot is not None
    assert earlier.snapshot.clock_high_water == friday.isoformat()


# -----------------------------------------------------------------------------
# The signature, re-checked properly
# -----------------------------------------------------------------------------


def seed_cache(
    storage: MemoryStorage,
    fingerprint: str,
    product_slug: str,
    license_id: str,
    envelope: dict[str, str],
) -> None:
    """Write a sealed cache by hand, holding a signed envelope.

    Going through ``activate`` is not an option: it verifies the nonce before it
    stores anything, and a captured envelope belongs to the request that
    produced it. Sealing the file directly is exactly what the client does on
    the next line anyway, and it is the only way to ask "what does this client
    make of a cache that already exists?".
    """
    cached = {
        "version": 1,
        "snapshot": {
            "license_id": license_id,
            "product": product_slug,
            "type": "subscription",
            "status": "active",
            "tier": "pro",
            "features": ["teams"],
            "seat_id": 42,
            "device_fingerprint": fingerprint,
            "not_before": None,
            "expires_at": "2026-12-31T23:59:59+00:00",
            "offline_valid_until": "2026-03-08T09:00:00+00:00",
            "next_check_after": "2026-03-01T21:00:00+00:00",
            "grace_period_days": 7,
            "max_version": None,
            "last_check_at": "2026-03-01T09:00:00+00:00",
            "clock_high_water": "2026-03-01T09:00:00+00:00",
            "seats": None,
            "warnings": [],
        },
        "device_access_token": "a",
        "device_refresh_token": "b",
        "signed_license": envelope,
        "api_base_url": "https://api.example.test/api/v1",
    }
    nonce = bytes(12)
    sealed = seal_with_nonce(canonical_json_bytes(cached), fingerprint, product_slug, nonce)
    storage.write(
        json.dumps(
            {
                "v": 1,
                "alg": "AES-256-GCM",
                "nonce": base64.b64encode(nonce).decode("ascii"),
                "ciphertext": base64.b64encode(sealed).decode("ascii"),
            }
        ).encode("utf-8")
    )


ENVELOPE = SIGNATURES["valid"]["envelope"]
CLAIMS = json.loads(base64.urlsafe_b64decode(ENVELOPE["payload"] + "=="))


def test_a_matching_envelope_is_accepted(server: FakeServer) -> None:
    storage = MemoryStorage()
    seed_cache(
        storage,
        CLAIMS["device_fingerprint"],
        CLAIMS["product"],
        CLAIMS["license_id"],
        ENVELOPE,
    )
    events: list[LicenseEvent] = []
    client = make_client(
        server,
        storage=storage,
        product_slug=CLAIMS["product"],
        device=DeviceIdentity(fingerprint=CLAIMS["device_fingerprint"], components={}),
        on_event=events.append,
    )
    client.load()

    assert client.verify_cached_signature() is True
    assert any(event.type == "signature.verified" for event in events)


def test_an_envelope_for_another_product_is_rejected(server: FakeServer) -> None:
    # A genuine signature over somebody else's product verifies perfectly. The
    # maths is not the question; what the claims say about *this* cache is.
    storage = MemoryStorage()
    seed_cache(
        storage, CLAIMS["device_fingerprint"], "flashtrix", CLAIMS["license_id"], ENVELOPE
    )
    client = make_client(
        server,
        storage=storage,
        product_slug="flashtrix",
        device=DeviceIdentity(fingerprint=CLAIMS["device_fingerprint"], components={}),
    )
    client.load()

    assert client.verify_cached_signature() is False


def test_an_envelope_for_another_machine_is_rejected(server: FakeServer) -> None:
    storage = MemoryStorage()
    other = "c" * 64
    seed_cache(storage, other, CLAIMS["product"], CLAIMS["license_id"], ENVELOPE)
    client = make_client(
        server,
        storage=storage,
        product_slug=CLAIMS["product"],
        device=DeviceIdentity(fingerprint=other, components={}),
    )
    client.load()

    assert client.verify_cached_signature() is False


def test_an_envelope_naming_a_different_licence_is_rejected(server: FakeServer) -> None:
    # The cache assembled from parts: a real envelope, a real snapshot, and they
    # are not about the same licence.
    storage = MemoryStorage()
    seed_cache(
        storage,
        CLAIMS["device_fingerprint"],
        CLAIMS["product"],
        "lic_somebody_else",
        ENVELOPE,
    )
    events: list[LicenseEvent] = []
    client = make_client(
        server,
        storage=storage,
        product_slug=CLAIMS["product"],
        device=DeviceIdentity(fingerprint=CLAIMS["device_fingerprint"], components={}),
        on_event=events.append,
    )
    client.load()

    assert client.verify_cached_signature() is False
    rejected = next(event for event in events if event.type == "signature.rejected")
    assert "licence" in rejected.data["reason"]


def test_an_envelope_from_an_unknown_key_is_rejected(server: FakeServer) -> None:
    storage = MemoryStorage()
    seed_cache(
        storage,
        CLAIMS["device_fingerprint"],
        CLAIMS["product"],
        CLAIMS["license_id"],
        ENVELOPE,
    )
    client = make_client(
        server,
        storage=storage,
        product_slug=CLAIMS["product"],
        device=DeviceIdentity(fingerprint=CLAIMS["device_fingerprint"], components={}),
        # A client older than the key rotation. Never "try them all": an unknown
        # key id means say so.
        public_keys={"some_other_key": SIGNATURES["publicKey"]},
    )
    client.load()

    assert client.verify_cached_signature() is False


def test_there_is_nothing_to_check_before_a_load(server: FakeServer) -> None:
    assert make_client(server).verify_cached_signature() is False


# -----------------------------------------------------------------------------
# A cache this version cannot use
# -----------------------------------------------------------------------------


def test_a_future_cache_format_is_discarded(server: FakeServer) -> None:
    storage = MemoryStorage()
    storage.write(
        json.dumps({"v": 99, "alg": "AES-256-GCM", "nonce": "", "ciphertext": ""}).encode()
    )
    events: list[LicenseEvent] = []
    client = make_client(server, storage=storage, on_event=events.append)

    assert client.load().state.value == "NOT_ACTIVATED"
    discarded = next(event for event in events if event.type == "cache.discarded")
    assert discarded.data["reason"] == "wrong-format"
    # And it is removed, so the next start does not pay for it again.
    assert storage.read() is None


def test_a_cache_that_decrypts_to_the_wrong_shape_is_discarded(server: FakeServer) -> None:
    # The outer container is this version's, the key is right, and the payload
    # is from something else entirely - a partially written file, or a hand
    # edit. It has to fail as "not activated", not as a crash on a missing field
    # three calls later.
    storage = MemoryStorage()
    nonce = bytes(12)
    sealed = seal_with_nonce(
        json.dumps({"version": 99, "snapshot": None}).encode(),
        FINGERPRINT,
        "teampromanager",
        nonce,
    )
    storage.write(
        json.dumps(
            {
                "v": 1,
                "alg": "AES-256-GCM",
                "nonce": base64.b64encode(nonce).decode("ascii"),
                "ciphertext": base64.b64encode(sealed).decode("ascii"),
            }
        ).encode()
    )
    events: list[LicenseEvent] = []
    client = make_client(server, storage=storage, on_event=events.append)

    assert client.load().state.value == "NOT_ACTIVATED"
    discarded = next(event for event in events if event.type == "cache.discarded")
    assert discarded.data["reason"] == "unreadable"


# -----------------------------------------------------------------------------
# Feature lookup, prepared
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "feature",
    [
        "teams",
        "export.csv",
        "export.",
        "export",
        "exportable",
        "reports.monthly",
        "reports.weekly",
        "",
        "anything",
    ],
)
def test_the_index_answers_what_the_linear_lookup_does(feature: str) -> None:
    from uplytech_license import has_feature

    granted = ["teams", "export.*", "reports.monthly"]
    assert FeatureIndex(granted).has(feature) is has_feature(granted, feature)


def test_a_licence_granting_everything_short_circuits() -> None:
    index = FeatureIndex(["*"])
    assert index.has("anything at all") is True
    # An empty query is still not a feature, star or no star.
    assert index.has("") is False


def test_a_lone_star_does_not_become_an_empty_prefix() -> None:
    assert FeatureIndex(["*"]).granted(["a", "b"]) == ["a", "b"]


def test_the_index_is_rebuilt_when_the_licence_changes(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    server.on("/licenses/device/heartbeat", (200, status_body(features=["teams"])))
    client = make_client(server, now=lambda: datetime(2026, 3, 2, 9, 0, tzinfo=UTC))
    client.activate(KEY)
    assert client.has_feature("time_tracking") is True

    client.heartbeat()

    assert client.has_feature("time_tracking") is False
    assert client.has_feature("teams") is True


# -----------------------------------------------------------------------------
# What to put in front of a person
# -----------------------------------------------------------------------------


def test_whole_days_to_expiry(server: FakeServer) -> None:
    server.on(
        "/licenses/device/activate",
        (201, activation_body(license=status_body(expires_at="2026-03-08T09:00:00+00:00"))),
    )
    client = make_client(server)
    client.activate(KEY)

    assert client.days_until_expiry == 7


def test_no_expiry_means_no_count(server: FakeServer) -> None:
    server.on(
        "/licenses/device/activate",
        (201, activation_body(license=status_body(type="perpetual", expires_at=None))),
    )
    client = make_client(server)
    client.activate(KEY)

    assert client.days_until_expiry is None


def test_an_unreadable_expiry_counts_as_none(server: FakeServer) -> None:
    server.on(
        "/licenses/device/activate",
        (201, activation_body(license=status_body(expires_at="the first of never"))),
    )
    client = make_client(server)
    client.activate(KEY)

    assert client.days_until_expiry is None


def test_warnings_are_passed_through_unchanged(server: FakeServer) -> None:
    server.on(
        "/licenses/device/activate",
        (
            201,
            activation_body(
                license=status_body(warnings=["expires_in_7_days", "vm_detected"])
            ),
        ),
    )
    client = make_client(server)
    client.activate(KEY)

    # Identifiers, not sentences: an application looks them up in its own
    # message table, and shipping English from here would break every localised
    # product.
    assert client.warnings == ("expires_in_7_days", "vm_detected")


def test_no_granted_features_while_the_licence_may_not_run(server: FakeServer) -> None:
    server.on(
        "/licenses/device/activate",
        (201, activation_body(license=status_body(status="revoked"))),
    )
    client = make_client(server)
    client.activate(KEY)

    assert client.granted_features(["teams", "tasks"]) == []


def test_granted_features_while_it_may(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    client = make_client(server)
    client.activate(KEY)

    assert client.granted_features(["teams", "sso", "tasks"]) == ["teams", "tasks"]


def test_warnings_before_anything_is_loaded(server: FakeServer) -> None:
    assert make_client(server).warnings == ()


# -----------------------------------------------------------------------------
# A licence that belongs to a guild rather than a machine
# -----------------------------------------------------------------------------


def test_the_subject_given_to_the_constructor_is_sent(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    client = make_client(server, subject={"type": "discord_guild", "ref": "123"})

    client.activate(KEY)

    assert server.calls[0]["body"]["subject"] == {"type": "discord_guild", "ref": "123"}


def test_the_call_can_override_it(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    client = make_client(server, subject={"type": "discord_guild", "ref": "123"})

    client.activate(KEY, {"type": "discord_guild", "ref": "456"})

    assert server.calls[0]["body"]["subject"]["ref"] == "456"


def test_none_is_sent_when_there_is_none(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    client = make_client(server)

    client.activate(KEY)

    assert "subject" not in server.calls[0]["body"]


def test_a_trial_carries_the_subject_too(server: FakeServer) -> None:
    server.on("/licenses/device/trial", (201, activation_body()))
    client = make_client(server, subject={"type": "discord_guild", "ref": "123"})

    client.start_trial("user-token")

    assert server.calls[0]["body"]["subject"]["ref"] == "123"


# -----------------------------------------------------------------------------
# The memo
# -----------------------------------------------------------------------------


def test_the_memo_does_not_go_stale_when_the_clock_moves(server: FakeServer) -> None:
    server.on(
        "/licenses/device/activate",
        (201, activation_body(license=status_body(expires_at="2026-03-01T09:00:10+00:00"))),
    )
    clock = {"now": NOW}
    client = make_client(server, now=lambda: clock["now"])
    client.activate(KEY)
    assert client.state.value == "ACTIVE"

    clock["now"] = NOW + timedelta(seconds=20)

    # A memo keyed only on the snapshot would still say ACTIVE here.
    assert client.state.value == "LOCKED_EXPIRED"


def test_the_memo_is_dropped_with_the_cache(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    client = make_client(server)
    client.activate(KEY)
    assert client.state.value == "ACTIVE"

    client.reset()

    assert client.state.value == "NOT_ACTIVATED"


def test_the_memo_answers_the_same_thing_it_would_have(server: FakeServer) -> None:
    server.on("/licenses/device/activate", (201, activation_body()))
    client = make_client(server)
    client.activate(KEY)

    first = client.evaluation
    second = client.evaluation

    assert second is first
    assert second.state.value == "ACTIVE"
