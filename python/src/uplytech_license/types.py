"""The shapes that travel between this library, the server and the caller.

Field names are snake_case here and on the wire; the TypeScript edition uses
camelCase for the same fields and translates once, in its transport. The shared
vectors use the camelCase spelling throughout, and the Python test suite maps
them - one spelling in the files keeps the diffs readable.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from typing import Any

LicenseStatus = str
"""One of: pending, active, trialing, suspended, expired, revoked."""

LicenseType = str
"""One of: subscription, perpetual, trial, free."""


@dataclass(frozen=True, slots=True)
class SeatCounts:
    total: int
    used: int
    available: int


@dataclass(frozen=True, slots=True)
class LicenseSnapshot:
    """What the client keeps between runs."""

    license_id: str = ""
    product: str = ""
    type: LicenseType = "subscription"
    status: LicenseStatus = "active"
    tier: str = ""
    features: tuple[str, ...] = ()
    seat_id: int | None = None
    #: The machine this licence is bound to. ``None`` for a seatless licence.
    device_fingerprint: str | None = None
    not_before: str | None = None
    expires_at: str | None = None
    offline_valid_until: str | None = None
    next_check_after: str | None = None
    grace_period_days: int = 7
    max_version: str | None = None
    last_check_at: str = ""
    #: Highest time this installation has ever seen. Inside the sealed cache.
    clock_high_water: str = ""
    seats: SeatCounts | None = None
    warnings: tuple[str, ...] = ()

    def replace(self, **changes: Any) -> LicenseSnapshot:
        return replace(self, **changes)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> LicenseSnapshot:
        seats = data.get("seats")
        known = {f for f in cls.__dataclass_fields__ if f not in {"seats"}}
        payload: dict[str, Any] = {key: value for key, value in data.items() if key in known}
        for sequence in ("features", "warnings"):
            if sequence in payload and payload[sequence] is not None:
                payload[sequence] = tuple(payload[sequence])
        return cls(
            **payload,
            seats=SeatCounts(**seats) if isinstance(seats, dict) else None,
        )


@dataclass(slots=True)
class CachedLicense:
    """What the cache file holds, once opened."""

    snapshot: LicenseSnapshot
    device_access_token: str
    device_refresh_token: str
    #: The envelope as it arrived, so the signature can be re-checked later.
    signed_license: dict[str, str] | None
    api_base_url: str
    version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "snapshot": self.snapshot.to_dict(),
            "device_access_token": self.device_access_token,
            "device_refresh_token": self.device_refresh_token,
            "signed_license": self.signed_license,
            "api_base_url": self.api_base_url,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CachedLicense:
        return cls(
            version=int(data["version"]),
            snapshot=LicenseSnapshot.from_dict(data["snapshot"]),
            device_access_token=str(data["device_access_token"]),
            device_refresh_token=str(data["device_refresh_token"]),
            signed_license=data.get("signed_license"),
            api_base_url=str(data.get("api_base_url", "")),
        )


@dataclass(frozen=True, slots=True)
class DeviceIdentity:
    """Everything the activation endpoint wants about this machine, hashed."""

    fingerprint: str
    components: dict[str, str] = field(default_factory=dict)
    install_id: str | None = None
    name: str = ""
    platform: str = ""
    os_version: str = ""
    vm_suspected: bool = False


@dataclass(frozen=True, slots=True)
class EntitlementResult:
    """The answer to "is this subject entitled?". Always given, licence or not.

    ``licensed`` false is a real answer rather than an absence: a freemium
    product reads the free tier's name and features out of the same shape and
    branches once, instead of turning a 404 into business logic.
    """

    licensed: bool
    #: The free tier's name when ``licensed`` is false, so a caller can branch.
    tier: str = ""
    features: tuple[str, ...] = ()
    license_id: str | None = None
    expires_at: str | None = None
    subject: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EntitlementResult:
        return cls(
            licensed=bool(data.get("licensed")),
            tier=str(data.get("tier") or ""),
            features=tuple(data.get("features") or ()),
            license_id=data.get("license_id"),
            expires_at=data.get("expires_at"),
            subject=dict(data.get("subject") or {}),
        )
