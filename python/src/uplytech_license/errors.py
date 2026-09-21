"""One error class per thing that can go wrong, because the caller reacts
differently to each.

A malformed key is a message next to the input field. A seat limit is a dialog
offering to free one. A network failure while a valid cache is still inside its
offline window is not an error at all - the application keeps running and tries
again later. Collapsing these into one exception is what makes licence dialogs
unhelpful.
"""

from __future__ import annotations

from typing import Any


class LicenseError(Exception):
    """Base for everything this package raises."""

    #: Stable identifier, safe to switch on and to look up in a message table.
    code = "license_error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class ValidationError(LicenseError):
    """The caller asked for something this library will not send.

    Raised before any request, and only for a limit the server also enforces -
    so the difference between this and the 422 it prevents is a round trip and a
    clearer message, never a different rule.
    """

    code = "validation"


class InvalidKeyError(LicenseError):
    """The typed key is not a licence key: wrong shape or failed checksum."""

    code = "invalid_key"


class CanonicalJsonError(LicenseError):
    """The serialiser was handed something it cannot render identically in
    both editions."""

    code = "canonical_json"


class SignatureError(LicenseError):
    """A signature did not verify, or the envelope was not what it claimed."""

    code = "bad_signature"


class CacheError(LicenseError):
    """The cache could not be read.

    Never fatal. The caller discards the file and carries on as if nothing had
    been activated yet - a corrupt cache after a power cut must not stop the
    application from starting.
    """

    code = "cache_unreadable"


class ApiError(LicenseError):
    """The server said no. Carries the status and the server's own code."""

    code = "api_error"

    def __init__(
        self,
        message: str,
        status: int,
        code: str = "api_error",
        detail: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.detail = detail


class SeatLimitError(ApiError):
    """Every seat is taken.

    Carries the list of machines holding one, so the application can ask which
    to free instead of telling the customer to contact support.
    """

    def __init__(self, message: str, seats: dict[str, Any]) -> None:
        super().__init__(message, 409, "seat_limit", seats)
        self.seats = seats


class RateLimitError(ApiError):
    """The server asked for a pause.

    Distinct from a plain :class:`ApiError` because the caller can do something
    specific with it: show "try again in a minute" rather than "something went
    wrong", and schedule rather than poll. ``retry_after`` is ``None`` when the
    server sent no usable ``Retry-After``.

    The transport only raises this after it has already retried within its
    policy, so reaching a caller means the pause was longer than the client was
    willing to block for.
    """

    code = "rate_limited"

    def __init__(self, message: str, retry_after: float | None) -> None:
        super().__init__(message, 429, "rate_limited", {"retry_after": retry_after})
        self.retry_after = retry_after


class NetworkError(LicenseError):
    """The server could not be reached. Distinct from a refusal by the server."""

    code = "network"

    def __init__(self, message: str, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class NotActivatedError(LicenseError):
    """An operation needs an activated device and there is none."""

    code = "not_activated"

    def __init__(self, message: str = "This installation is not activated") -> None:
        super().__init__(message)
