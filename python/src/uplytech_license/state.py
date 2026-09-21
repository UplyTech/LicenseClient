"""The decision: may this application run right now?

A pure function over a cached snapshot and a clock. Everything that touches the
network, the disk or the operating system lives elsewhere, so this - the part
that can lock a paying customer out - is fully testable and pinned by the
shared vectors.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum

from .semver import version_within
from .types import LicenseSnapshot


class LicenseState(StrEnum):
    NOT_ACTIVATED = "NOT_ACTIVATED"
    ACTIVE = "ACTIVE"
    LOCKED_OFFLINE = "LOCKED_OFFLINE"
    LOCKED_EXPIRED = "LOCKED_EXPIRED"
    LOCKED_REVOKED = "LOCKED_REVOKED"
    LOCKED_SUSPENDED = "LOCKED_SUSPENDED"
    LOCKED_NOT_YET_VALID = "LOCKED_NOT_YET_VALID"
    LOCKED_WRONG_DEVICE = "LOCKED_WRONG_DEVICE"
    LOCKED_CLOCK = "LOCKED_CLOCK"
    LOCKED_VERSION = "LOCKED_VERSION"


#: How far a clock may be behind the highest time ever seen.
DEFAULT_CLOCK_TOLERANCE_HOURS = 24


@dataclass(frozen=True, slots=True)
class Evaluation:
    state: LicenseState
    #: Stable identifier for the reason, or ``None`` when nothing is wrong.
    reason: str | None
    can_run: bool
    #: Whether the client should contact the server, blocking or not.
    should_check_in: bool
    #: Whole days of offline window left. Negative once it has run out.
    days_left_offline: int | None


@dataclass(frozen=True, slots=True)
class ClockCheck:
    rolled_back: bool
    #: The mark to store. Never earlier than the one that came in.
    new_high_water: datetime


def _parse(value: str | datetime | None) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def check_clock(
    now: datetime,
    clock_high_water: str | datetime | None,
    tolerance_hours: int = DEFAULT_CLOCK_TOLERANCE_HOURS,
) -> ClockCheck:
    """Compare the clock against the highest time this installation has seen.

    Winding the clock back is the cheapest way to reopen an expired offline
    window, so the mark lives inside the encrypted cache. Beside it, in a plain
    settings file, it would be a two-line bypass.

    The tolerance exists because honest clocks are wrong: a flat CMOS battery,
    a laptop crossing time zones, a virtual machine resuming from a snapshot.
    None of those should lock anybody out.
    """
    mark = _parse(clock_high_water)
    if mark is None or now >= mark:
        return ClockCheck(rolled_back=False, new_high_water=now)

    behind = mark - now
    return ClockCheck(
        # The mark never moves backwards, so restarting the application does
        # not reset it.
        rolled_back=behind > timedelta(hours=tolerance_hours),
        new_high_water=mark,
    )


def evaluate(
    snapshot: LicenseSnapshot | None,
    now: datetime,
    *,
    fingerprint: str | None = None,
    clock_tolerance_hours: int = DEFAULT_CLOCK_TOLERANCE_HOURS,
    app_version: str | None = None,
) -> Evaluation:
    """Decide what to do with a cached licence.

    Order matters and is not arbitrary:

    1. no cache at all
    2. the cache belongs to another machine - the copy protection
    3. the clock was wound back - everything below reads a date
    4. the last word from the server: revoked, suspended
    5. the contract: not yet started, expired, past the update window
    6. the connection: offline window exhausted

    Revocation before expiry, and both before the offline window, because the
    grace period covers connection trouble and must never soften a decision the
    server actually made.

    The update window sits with the contract rather than with the connection for
    the same reason: "you bought the 1.x line" is something the seller decided,
    not something a bad hotel network caused.

    ``app_version`` is optional. Omitting it skips the update-window check
    entirely, which is what a caller who does not know its own version should
    get: no answer rather than a wrong one.
    """
    if snapshot is None:
        return Evaluation(
            state=LicenseState.NOT_ACTIVATED,
            reason="no_license",
            can_run=False,
            should_check_in=False,
            days_left_offline=None,
        )

    offline_until = _parse(snapshot.offline_valid_until)
    days_left = None if offline_until is None else (offline_until - now) // timedelta(days=1)

    next_check = _parse(snapshot.next_check_after)
    should_check_in = True if next_check is None else now >= next_check

    def locked(state: LicenseState, reason: str) -> Evaluation:
        return Evaluation(
            state=state,
            reason=reason,
            can_run=False,
            # Always worth asking the server: a suspension is lifted when the
            # invoice is paid, and the customer should not have to reinstall.
            should_check_in=True,
            days_left_offline=days_left,
        )

    # The second line of the copy protection. The first is that the cache is
    # encrypted with a key derived from the fingerprint, so a file carried to
    # another machine does not decrypt at all and never reaches this function.
    # This check catches the case where a snapshot arrives some other way - and
    # it keeps standing if the cache format ever stops binding the key to the
    # machine.
    bound = snapshot.device_fingerprint
    if bound and fingerprint and bound != fingerprint:
        return locked(LicenseState.LOCKED_WRONG_DEVICE, "fingerprint_mismatch")

    if check_clock(now, snapshot.clock_high_water, clock_tolerance_hours).rolled_back:
        return locked(LicenseState.LOCKED_CLOCK, "clock_rolled_back")

    if snapshot.status == "revoked":
        return locked(LicenseState.LOCKED_REVOKED, "revoked")
    if snapshot.status == "suspended":
        return locked(LicenseState.LOCKED_SUSPENDED, "suspended")

    not_before = _parse(snapshot.not_before)
    if not_before is not None and now < not_before:
        return locked(LicenseState.LOCKED_NOT_YET_VALID, "not_yet_valid")

    # A missing expiry is a perpetual licence, not an expiry at the epoch.
    expires_at = _parse(snapshot.expires_at)
    if expires_at is not None and now > expires_at:
        return locked(LicenseState.LOCKED_EXPIRED, "expired")

    if snapshot.status == "expired":
        return locked(LicenseState.LOCKED_EXPIRED, "expired")

    # The update window. A perpetual licence for the 1.x line does not cover
    # 2.0, and until this check existed the client stored ``max_version`` and
    # never read it. Unreadable on either side means "do not lock" - see
    # :func:`version_within`.
    if not version_within(app_version, snapshot.max_version):
        return locked(LicenseState.LOCKED_VERSION, "version_not_covered")

    # "Valid until" - being exactly on the deadline still counts.
    if offline_until is not None and now > offline_until:
        return locked(LicenseState.LOCKED_OFFLINE, "offline_too_long")

    return Evaluation(
        state=LicenseState.ACTIVE,
        reason=None,
        can_run=True,
        should_check_in=should_check_in,
        days_left_offline=days_left,
    )
