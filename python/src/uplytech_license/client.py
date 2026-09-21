"""The one class an application talks to.

Everything below it is pure and separately tested; this module is the wiring:
probe the machine, seal and unseal the cache, call the server, and decide what
the answer means.

The rule that shapes the whole design: **a network failure is not a licence
failure**. If the server cannot be reached and the cache is still inside its
offline window, the application carries on. Anything else turns a flaky
connection into a support ticket.
"""

from __future__ import annotations

import base64
import contextlib
import json
import os
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote

from .canonical_json import canonical_json_bytes
from .crypto import NONCE_BYTES, open_sealed, seal_with_nonce
from .errors import (
    ApiError,
    CacheError,
    NetworkError,
    NotActivatedError,
    SignatureError,
    ValidationError,
)
from .events import LicenseEventListener, emit
from .features import FeatureIndex
from .retry import NO_RETRY, RetryPolicy
from .signature import verify_envelope
from .state import (
    DEFAULT_CLOCK_TOLERANCE_HOURS,
    Evaluation,
    LicenseState,
    check_clock,
    evaluate,
)
from .storage import Storage
from .transport import Sender, Transport, normalise_api_url
from .types import (
    CachedLicense,
    DeviceIdentity,
    EntitlementResult,
    LicenseSnapshot,
    SeatCounts,
)

CACHE_FORMAT = 1

#: The server's own cap on ``verify/bulk``. Refusing here beats reading a 422.
MAX_BULK_SUBJECTS = 100


def _utcnow() -> datetime:
    return datetime.now(UTC)


class LicenseClient:
    def __init__(
        self,
        *,
        api_base_url: str,
        product_slug: str,
        app_version: str,
        public_keys: dict[str, str],
        storage: Storage,
        device: DeviceIdentity | None = None,
        install_id: str | None = None,
        request_timeout: float = 15.0,
        clock_tolerance_hours: int = DEFAULT_CLOCK_TOLERANCE_HOURS,
        retry: RetryPolicy | None = None,
        on_event: LicenseEventListener | None = None,
        subject: dict[str, str] | None = None,
        send: Sender | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.product_slug = product_slug
        self.api_base_url = normalise_api_url(api_base_url)
        self.app_version = app_version
        self.public_keys = public_keys
        self.clock_tolerance_hours = clock_tolerance_hours

        self._storage = storage
        self._now = now or _utcnow
        self._on_event = on_event
        self._subject = subject
        transport_kwargs: dict[str, Any] = {"on_event": on_event}
        if retry is not None:
            transport_kwargs["retry"] = retry
        self._transport = Transport(
            self.api_base_url, send, request_timeout, **transport_kwargs
        )
        self._cache: CachedLicense | None = None
        self._loaded = False

        #: The last evaluation, and what it was computed from.
        #:
        #: ``evaluation`` is a property an application reads from menu-enable
        #: code and render paths, and every read parses five ISO timestamps and
        #: runs the clock check. Caching it on the snapshot's identity and the
        #: current second makes repeated reads free without ever letting the
        #: answer go stale: a licence expires at a second boundary, and a
        #: snapshot that changes is a different object.
        #: Serialises ``ensure`` across threads. See the comment there.
        self._check_in_lock = threading.RLock()
        #: When the last check-in finished, on the monotonic clock. Negative
        #: infinity until one has, so the first caller never thinks it missed
        #: somebody else's.
        self._last_check_in = float("-inf")
        self._memo: tuple[int | None, int, Evaluation] | None = None
        #: Rebuilt whenever the snapshot's feature list changes.
        self._features: tuple[tuple[str, ...], FeatureIndex] | None = None

        if device is not None:
            self._device = device
        else:  # pragma: no cover - probing the real machine
            from .probe import identify_device

            self._device = identify_device(install_id)

    # -------------------------------------------------------------------------
    # Reading the current situation
    # -------------------------------------------------------------------------

    @property
    def fingerprint(self) -> str:
        return self._device.fingerprint

    @property
    def snapshot(self) -> LicenseSnapshot | None:
        return self._cache.snapshot if self._cache else None

    @property
    def evaluation(self) -> Evaluation:
        """The current decision. Call :meth:`load` first, or it says
        ``NOT_ACTIVATED``."""
        snapshot = self.snapshot
        now = self._now()
        second = int(now.timestamp())
        key = id(snapshot) if snapshot is not None else None

        if self._memo is not None and self._memo[0] == key and self._memo[1] == second:
            return self._memo[2]

        value = evaluate(
            snapshot,
            now,
            fingerprint=self._device.fingerprint,
            clock_tolerance_hours=self.clock_tolerance_hours,
            app_version=self.app_version,
        )

        if self._memo is not None and self._memo[2].state != value.state:
            emit(
                self._on_event,
                "state.changed",
                **{"from": self._memo[2].state.value, "to": value.state.value},
                reason=value.reason,
            )

        self._memo = (key, second, value)
        return value

    @property
    def state(self) -> LicenseState:
        return self.evaluation.state

    def has_feature(self, feature: str) -> bool:
        """Whether the licence covers a feature. False whenever it may not run.

        The "may not run" half is not a convenience. An application that checks
        ``has_feature`` but forgets ``can_run`` would keep its paid features
        working after the licence was revoked, which is the one mistake this
        method exists to make impossible.
        """
        if not self.evaluation.can_run:
            return False
        return self._feature_index().has(feature)

    def granted_features(self, wanted: Sequence[str]) -> list[str]:
        """Every feature in ``wanted`` the licence covers. Empty when it may
        not run."""
        if not self.evaluation.can_run:
            return []
        return self._feature_index().granted(wanted)

    def _feature_index(self) -> FeatureIndex:
        snapshot = self.snapshot
        source = snapshot.features if snapshot else ()
        if self._features is None or self._features[0] is not source:
            self._features = (source, FeatureIndex(source))
        return self._features[1]

    # -------------------------------------------------------------------------
    # What to put in front of a person
    # -------------------------------------------------------------------------

    @property
    def days_until_expiry(self) -> int | None:
        """Whole days until the licence expires, or ``None`` for one that does not.

        Rounded down, so "1 day left" means at least one full day. An
        application showing a renewal banner wants this rather than the raw
        timestamp, and rounding it in two places is how the banner and the lock
        disagree by a day.
        """
        snapshot = self.snapshot
        if snapshot is None or not snapshot.expires_at:
            return None
        try:
            expires = datetime.fromisoformat(snapshot.expires_at)
        except ValueError:
            return None
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=UTC)
        return (expires - self._now()) // timedelta(days=1)

    @property
    def warnings(self) -> tuple[str, ...]:
        """The server's own warnings, unchanged.

        Stable identifiers - ``expires_in_7_days``, ``clock_skew``,
        ``vm_detected`` - so an application looks them up in its own message
        table and translates them. Turning them into sentences here would mean
        shipping English into every localised product.
        """
        snapshot = self.snapshot
        return snapshot.warnings if snapshot else ()

    @property
    def version_covered(self) -> bool:
        """Whether this build is inside the licence's update window."""
        return self.evaluation.state is not LicenseState.LOCKED_VERSION

    # -------------------------------------------------------------------------
    # Cache
    # -------------------------------------------------------------------------

    def load(self) -> Evaluation:
        """Read the cache. Never raises for a damaged one.

        A corrupt cache after a power cut, a file copied from another machine,
        a format from a future version - all of it means the same thing: forget
        it and behave as if nothing had been activated. Refusing to start would
        turn a full disk into a licence problem.
        """
        self._loaded = True
        self._cache = None
        self._memo = None
        self._features = None

        raw = self._storage.read()
        if not raw:
            emit(self._on_event, "cache.missing")
            return self.evaluation

        discarded = "corrupt"
        try:
            container = json.loads(raw.decode("utf-8"))
            if not isinstance(container, dict) or container.get("v") != CACHE_FORMAT:
                discarded = "wrong-format"
                raise CacheError(f"Unknown cache format {container!r}")
            discarded = "wrong-machine"
            plaintext = open_sealed(
                base64.b64decode(container["ciphertext"]),
                self._device.fingerprint,
                self.product_slug,
                base64.b64decode(container["nonce"]),
            )
            discarded = "unreadable"
            parsed = json.loads(plaintext.decode("utf-8"))
            if not isinstance(parsed, dict) or parsed.get("version") != CACHE_FORMAT:
                raise CacheError("Cache contents are not what this version writes")
            self._cache = CachedLicense.from_dict(parsed)
        except (CacheError, ValueError, KeyError, TypeError) as error:
            # Silent to the *caller*, on purpose: it sees NOT_ACTIVATED and
            # offers the activation dialog, which is the only useful thing to do
            # about a cache that will not open. The event is how a support
            # engineer finds out which of the four reasons it was, on a machine
            # they cannot debug.
            emit(self._on_event, "cache.discarded", reason=discarded, detail=str(error))
            self._storage.clear()
            self._cache = None
            return self.evaluation

        # Advance the clock mark on every load, not only on a heartbeat.
        #
        # Without this, an application started offline on Monday and quit on
        # Friday leaves a mark from Monday - and Friday's user can wind the clock
        # back four days to reopen an offline window. Moving it forward whenever
        # the client sees a later time closes that, and it only ever moves
        # forward, so it can never shorten a window either.
        advanced = check_clock(
            self._now(), self._cache.snapshot.clock_high_water, self.clock_tolerance_hours
        )
        mark = advanced.new_high_water.isoformat()
        if mark != self._cache.snapshot.clock_high_water:
            self._cache.snapshot = self._cache.snapshot.replace(clock_high_water=mark)
            self._memo = None
            # Best effort. A read-only disk must not stop the application
            # starting; the mark simply does not advance until it can be written.
            with contextlib.suppress(OSError):
                self._persist()
        if advanced.rolled_back:
            emit(
                self._on_event,
                "clock.rolled_back",
                behind=(advanced.new_high_water - self._now()).total_seconds(),
            )

        evaluation = self.evaluation
        emit(self._on_event, "cache.loaded", state=evaluation.state.value)
        return evaluation

    def _persist(self) -> None:
        # Writing "no licence" means removing the file, not sealing an empty
        # one. Every caller already checks, so this is the belt to that pair of
        # braces - it is what keeps a future caller from writing a cache whose
        # snapshot is None, which would then fail to load on every start.
        if self._cache is None:  # pragma: no cover - see above
            self._storage.clear()
            return
        nonce = os.urandom(NONCE_BYTES)
        plaintext = canonical_json_bytes(self._cache.to_dict())
        ciphertext = seal_with_nonce(
            plaintext, self._device.fingerprint, self.product_slug, nonce
        )
        container = {
            "v": CACHE_FORMAT,
            "alg": "AES-256-GCM",
            "nonce": base64.b64encode(nonce).decode("ascii"),
            "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        }
        payload = json.dumps(container).encode("utf-8")
        self._storage.write(payload)
        emit(self._on_event, "cache.written", bytes=len(payload))

    def reset(self) -> None:
        """Forget everything locally. Does not free the seat - see
        :meth:`deactivate`."""
        self._cache = None
        self._memo = None
        self._features = None
        self._storage.clear()

    # -------------------------------------------------------------------------
    # Talking to the server
    # -------------------------------------------------------------------------

    def _device_payload(self) -> dict[str, Any]:
        return {
            "fingerprint": self._device.fingerprint,
            "components": self._device.components,
            "install_id": self._device.install_id,
            "name": self._device.name,
            "platform": self._device.platform,
            "os_version": self._device.os_version,
            "app_version": self.app_version,
            "vm_suspected": self._device.vm_suspected,
        }

    def activate(self, license_key: str, subject: dict[str, str] | None = None) -> Evaluation:
        """Activate this machine against a licence key.

        ``subject`` overrides the one given to the constructor, for a product
        whose licence belongs to a Discord guild or a team rather than to a
        computer.
        """
        nonce = str(uuid.uuid4())
        body: dict[str, Any] = {
            "license_key": license_key,
            "product_slug": self.product_slug,
            "nonce": nonce,
            "client_time": self._now().isoformat(),
            "device": self._device_payload(),
        }
        chosen = subject or self._subject
        if chosen:
            body["subject"] = chosen
        response = self._transport.request(
            "/licenses/device/activate",
            method="POST",
            body=body,
            # A person is watching an activation dialog. Two retries with
            # backoff is the right shape for a background heartbeat and the
            # wrong one here: better a clear message now than a spinner.
            retry=NO_RETRY,
        )
        self._adopt(response, nonce)
        return self.evaluation

    def start_trial(
        self,
        user_access_token: str,
        email: str | None = None,
        subject: dict[str, str] | None = None,
    ) -> Evaluation:
        """Start a trial.

        Needs a signed-in user: a trial is granted to an account, not to a
        machine, or the same computer could start one every fortnight.
        """
        nonce = str(uuid.uuid4())
        body: dict[str, Any] = {
            "product_slug": self.product_slug,
            "nonce": nonce,
            "client_time": self._now().isoformat(),
            "device": self._device_payload(),
        }
        if email:
            body["email"] = email
        chosen = subject or self._subject
        if chosen:
            body["subject"] = chosen
        response = self._transport.request(
            "/licenses/device/trial",
            method="POST",
            body=body,
            token=user_access_token,
            retry=NO_RETRY,
        )
        self._adopt(response, nonce)
        return self.evaluation

    def heartbeat(self) -> Evaluation:
        """Check in with the server.

        Refreshes the device token once on a 401 before giving up: the access
        token lives 24 hours, and an application closed over a weekend would
        otherwise ask its user to activate again for no reason.
        """
        if not self._loaded:
            self.load()
        if self._cache is None:
            raise NotActivatedError()

        def send(token: str) -> Any:
            return self._transport.request(
                "/licenses/device/heartbeat",
                method="POST",
                token=token,
                body={
                    "nonce": str(uuid.uuid4()),
                    "client_time": self._now().isoformat(),
                    "fingerprint": self._device.fingerprint,
                    "app_version": self.app_version,
                },
            )

        try:
            status = send(self._cache.device_access_token)
        except ApiError as error:
            if error.status != 401:
                raise
            self._refresh_device_token()
            status = send(self._cache.device_access_token)

        self._cache.snapshot = self._merge_status(self._cache.snapshot, status)
        self._persist()
        return self.evaluation

    def ensure(self) -> Evaluation:
        """The call an application makes at start-up and every few hours.

        Loads the cache, checks in when one is due, and swallows a network
        failure as long as the cache still permits running. It never raises for
        a connection problem; it raises when the server actually said no.
        """
        if not self._loaded:
            self.load()
        if self._cache is None:
            return self.evaluation

        before = self.evaluation
        if not before.should_check_in and before.can_run:
            return before

        # A bot's scheduler and its command handler both call this, from
        # different threads. Without the guard they are two round trips, two
        # nonces and two cache writes racing to be last.
        #
        # The mark is why re-checking ``should_check_in`` after the lock is not
        # enough on its own: the server can answer with a ``next_check_after``
        # that has already passed - it does, whenever a heartbeat is late - and
        # the second thread would then dutifully check in again. What actually
        # settles it is "did a check-in finish while I was waiting", which is
        # what the timestamp records. The asynchronous edition gets the same
        # answer by sharing one promise between overlapping callers.
        entered = time.monotonic()
        with self._check_in_lock:
            if self._last_check_in > entered:
                return self.evaluation
            try:
                return self.heartbeat()
            except NetworkError:
                # Offline. The evaluation already knows whether that is still
                # allowed.
                return self.evaluation
            except ApiError as error:
                if error.status >= 500:
                    # The server is having a bad day. Not the customer's
                    # problem.
                    return self.evaluation
                raise
            finally:
                self._last_check_in = time.monotonic()

    def deactivate(self) -> None:
        """Free this machine's seat and forget the licence locally."""
        if not self._loaded:
            self.load()
        if self._cache is None:
            return

        # A seat that cannot be freed right now is better than a client stuck
        # with a licence it has already told the user it removed. The server
        # reclaims stale seats on its own.
        with contextlib.suppress(NetworkError, ApiError):
            self._transport.request(
                "/licenses/device/deactivate",
                method="POST",
                token=self._cache.device_access_token,
            )
        self.reset()

    def device_status(self) -> dict[str, Any]:
        """Read the server's view without changing anything.

        A heartbeat is a write: it moves the seat's ``last_seen_at``, extends
        the offline window and resets ``next_check_after``. That makes it the
        wrong call for a diagnostics screen, a support tool, or a "check now"
        button somebody can hold down - each of those would quietly extend the
        very window it is meant to be reporting on.

        This one only reads. The result is returned rather than adopted, so
        nothing about the cached decision changes either.
        """
        if not self._loaded:
            self.load()
        if self._cache is None:
            raise NotActivatedError()

        def send(token: str) -> Any:
            return self._transport.request("/licenses/device/status", token=token)

        try:
            return send(self._cache.device_access_token)  # type: ignore[no-any-return]
        except ApiError as error:
            if error.status != 401:
                raise
            self._refresh_device_token()
            return send(self._cache.device_access_token)  # type: ignore[no-any-return]

    # -------------------------------------------------------------------------
    # Seats, from the owner's side
    #
    # The device endpoints can only ever free *this* machine. These are the ones
    # behind "my laptop died and it is still holding a seat", and they need the
    # signed-in user's token rather than the device's - freeing somebody else's
    # machine is an account-level decision.
    # -------------------------------------------------------------------------

    def list_seats(self, user_access_token: str, license_id: str) -> list[dict[str, Any]]:
        """Every seat on a licence, including released ones.

        This is what turns :class:`SeatLimitError` from a dead end into a
        dialog: the error already names the machines holding a seat, and this
        lists them again with their last-seen times so a person can tell which
        one is the laptop they threw away.
        """
        answer = self._transport.request(
            f"/licenses/{quote(license_id, safe='')}/seats", token=user_access_token
        )
        return list(answer or [])

    def release_seat(self, user_access_token: str, license_id: str, seat_id: int) -> None:
        """Free a seat held by another machine.

        Subject to a quota on the server, unlike a device releasing itself: this
        is the path a shared key would be rotated through, and an unlimited
        version of it would make the seat limit advisory.
        """
        self._transport.request(
            f"/licenses/{quote(license_id, safe='')}/seats/{seat_id}",
            method="DELETE",
            token=user_access_token,
        )

    # -------------------------------------------------------------------------
    # The owner's own licences
    # -------------------------------------------------------------------------

    def list_licenses(
        self, user_access_token: str, page: int = 1, page_size: int = 20
    ) -> dict[str, Any]:
        """The signed-in user's licences, for an account screen."""
        answer = self._transport.request(
            "/licenses",
            token=user_access_token,
            query={"page": page, "page_size": page_size},
        )
        return dict(answer or {})

    def get_license(self, user_access_token: str, license_id: str) -> dict[str, Any]:
        """One of the signed-in user's licences."""
        answer = self._transport.request(
            f"/licenses/{quote(license_id, safe='')}", token=user_access_token
        )
        return dict(answer or {})

    def reveal_key(self, user_access_token: str, license_id: str) -> str:
        """Show the customer their own licence key.

        A key that only ever existed in one email is a key that is gone the
        moment that mailbox is. The server scopes this to the caller's own
        account, logs every call, and rate limits the path; the client's only
        job is not to keep the answer anywhere. It is returned and never cached,
        never written to the sealed file, and never put into an event.
        """
        answer = self._transport.request(
            f"/licenses/{quote(license_id, safe='')}/key",
            method="POST",
            token=user_access_token,
            retry=NO_RETRY,
        )
        return str((answer or {}).get("license_key", ""))

    # -------------------------------------------------------------------------
    # Entitlement, for a product that is not per-machine
    #
    # A Discord bot serves thousands of guilds from one process. There is no
    # seat to activate and no cache to keep: the question is "is *this guild*
    # entitled?", asked per command, and the server answers 200 either way so a
    # freemium product can read a plain "not licensed" instead of turning a 404
    # into business logic.
    # -------------------------------------------------------------------------

    def verify_subject(
        self,
        api_key: str,
        subject: dict[str, str],
        product_slug: str | None = None,
    ) -> EntitlementResult:
        """Is one subject entitled?

        Needs a server-to-server API key, not a user token - the caller is a
        bot, not a person. Answers for an unlicensed subject too, with the free
        tier's name and features, so there is one code path rather than two.
        """
        answer = self._transport.request(
            "/licenses/verify",
            token=api_key,
            query={
                "product_slug": product_slug or self.product_slug,
                "subject_type": subject["type"],
                "subject_ref": subject["ref"],
            },
        )
        return EntitlementResult.from_dict(answer or {})

    def verify_subjects(
        self,
        api_key: str,
        refs: Sequence[str],
        subject_type: str = "discord_guild",
        product_slug: str | None = None,
    ) -> list[EntitlementResult]:
        """Up to a hundred subjects in one round trip.

        A bot in five thousand guilds asking one at a time would poll the API to
        death, and the server caps the batch at a hundred - so this refuses a
        larger one here rather than sending it and reading the 422 back.
        """
        if not refs:
            return []
        if len(refs) > MAX_BULK_SUBJECTS:
            raise ValidationError(
                f"verify_subjects takes at most {MAX_BULK_SUBJECTS} subjects "
                f"at a time, got {len(refs)}"
            )
        answer = self._transport.request(
            "/licenses/verify/bulk",
            method="POST",
            token=api_key,
            body={
                "product_slug": product_slug or self.product_slug,
                "subject_type": subject_type,
                "subject_refs": list(refs),
            },
        )
        return [EntitlementResult.from_dict(row) for row in (answer or [])]

    def _refresh_device_token(self) -> None:
        if self._cache is None:  # pragma: no cover - guarded by the caller
            raise NotActivatedError()
        response = self._transport.request(
            "/licenses/device/token/refresh",
            method="POST",
            body={"refresh_token": self._cache.device_refresh_token},
        )
        self._cache.device_access_token = response["device_access_token"]
        self._cache.device_refresh_token = response["device_refresh_token"]
        self._persist()
        emit(self._on_event, "token.refreshed")

    # -------------------------------------------------------------------------
    # Turning a response into a snapshot
    # -------------------------------------------------------------------------

    def _adopt(self, response: dict[str, Any], nonce: str) -> None:
        claims = self._verify(response.get("signed_license"), nonce)
        licence = response["license"]
        now = self._now()

        seats = licence.get("seats")
        seat_id = response.get("seat_id", licence.get("seat_id"))

        snapshot = LicenseSnapshot(
            license_id=licence["license_id"],
            product=licence["product"],
            type=licence["type"],
            status=licence["status"],
            tier=licence["tier"],
            features=tuple(licence.get("features") or ()),
            seat_id=seat_id,
            device_fingerprint=(
                (claims or {}).get("device_fingerprint")
                if claims
                else (None if seat_id is None else self._device.fingerprint)
            ),
            not_before=(claims or {}).get("not_before"),
            expires_at=licence.get("expires_at"),
            offline_valid_until=licence.get("offline_valid_until"),
            next_check_after=licence.get("next_check_after"),
            grace_period_days=licence.get("grace_period_days", 7),
            max_version=licence.get("max_version"),
            last_check_at=now.isoformat(),
            clock_high_water=check_clock(
                now, None, self.clock_tolerance_hours
            ).new_high_water.isoformat(),
            seats=SeatCounts(**seats) if isinstance(seats, dict) else None,
            warnings=tuple(licence.get("warnings") or ())
            + tuple(response.get("warnings") or ()),
        )

        self._cache = CachedLicense(
            snapshot=snapshot,
            device_access_token=response["device_access_token"],
            device_refresh_token=response["device_refresh_token"],
            signed_license=response.get("signed_license"),
            api_base_url=self.api_base_url,
        )
        self._loaded = True
        self._persist()

    def _merge_status(
        self, previous: LicenseSnapshot, status: dict[str, Any]
    ) -> LicenseSnapshot:
        now = self._now()
        seats = status.get("seats")
        return previous.replace(
            status=status["status"],
            tier=status["tier"],
            features=tuple(status.get("features") or ()),
            seat_id=status.get("seat_id") or previous.seat_id,
            expires_at=status.get("expires_at"),
            offline_valid_until=status.get("offline_valid_until"),
            next_check_after=status.get("next_check_after"),
            grace_period_days=status.get("grace_period_days", previous.grace_period_days),
            max_version=status.get("max_version"),
            seats=SeatCounts(**seats) if isinstance(seats, dict) else None,
            warnings=tuple(status.get("warnings") or ()),
            last_check_at=now.isoformat(),
            # The mark only ever moves forward, so a heartbeat on a machine
            # whose clock is wrong does not quietly reset the protection.
            clock_high_water=check_clock(
                now, previous.clock_high_water, self.clock_tolerance_hours
            ).new_high_water.isoformat(),
        )

    def _verify(self, envelope: dict[str, str] | None, nonce: str) -> dict[str, Any] | None:
        """Verify the envelope, and check it was issued for *this* request and
        *this* machine.

        The signature alone is not enough: a captured older response is a valid
        signature over stale claims, and a response captured from a colleague's
        machine is a valid signature over somebody else's seat. The nonce
        closes the first, the fingerprint the second.
        """
        if not envelope:
            # The server runs unsigned in development. There is nothing to
            # verify, and the client simply checks back more often.
            return None

        claims = verify_envelope(envelope, self.public_keys)

        if claims.get("nonce") != nonce:
            raise SignatureError("The signed licence answers a different request")

        bound = claims.get("device_fingerprint")
        if isinstance(bound, str) and bound != self._device.fingerprint:
            raise SignatureError("The signed licence was issued for another machine")

        if claims.get("product") != self.product_slug:
            raise SignatureError(
                f"The signed licence is for {claims.get('product')!r}, "
                f"not {self.product_slug!r}"
            )

        return claims

    def verify_cached_signature(self) -> bool:
        """Re-check the stored envelope, and that it is still *this* licence.

        The signature alone answers a narrower question than it appears to. A
        genuine envelope for a different product, or for a different machine, or
        naming a different licence than the snapshot beside it, all verify
        perfectly - and all of them mean the cache has been assembled from
        parts. So the claims are compared against what the snapshot says as
        well.

        ``False`` rather than raising: this is a start-up integrity check, and
        the answer to a failed one is to re-activate, not to crash.
        """
        envelope = self._cache.signed_license if self._cache else None
        snapshot = self._cache.snapshot if self._cache else None
        if not envelope or snapshot is None:
            return False

        try:
            claims = verify_envelope(envelope, self.public_keys)
        except SignatureError as error:
            emit(
                self._on_event,
                "signature.rejected",
                key_id=envelope.get("key_id"),
                reason=str(error),
            )
            return False

        mismatch: str | None = None
        product = claims.get("product")
        bound = claims.get("device_fingerprint")
        license_id = claims.get("license_id")
        if product is not None and product != self.product_slug:
            mismatch = "product"
        elif isinstance(bound, str) and bound != self._device.fingerprint:
            mismatch = "device"
        elif isinstance(license_id, str) and license_id != snapshot.license_id:
            mismatch = "licence"

        if mismatch is not None:
            emit(
                self._on_event,
                "signature.rejected",
                key_id=envelope.get("key_id"),
                reason=f"{mismatch} does not match the cached licence",
            )
            return False

        emit(self._on_event, "signature.verified", key_id=envelope.get("key_id"))
        return True
