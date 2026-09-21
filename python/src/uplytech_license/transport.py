"""HTTP against the licence endpoints.

Built on ``urllib`` from the standard library rather than on ``httpx``. The
package already makes one deliberate dependency exception for ``cryptography``,
where the standard library genuinely cannot do the job; here it can. An
asynchronous caller - a Discord bot, most likely - either runs these calls in a
thread executor or passes its own ``send`` callable, which is why that hook
exists.

Small on purpose: one JSON call, one place that turns a status code into a typed
error, one place that normalises the base URL, and one place that decides
whether a failure is worth trying again. Everything above it deals in errors,
never in status codes.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from .errors import ApiError, NetworkError, RateLimitError, SeatLimitError
from .events import LicenseEventListener, emit
from .retry import (
    DEFAULT_RETRY,
    RetryPolicy,
    backoff_seconds,
    is_retryable_status,
    parse_retry_after,
)

API_PATH = "/api/v1"

_TRAILING_VERSION = re.compile(r"/(?:api/)?v1$", re.IGNORECASE)

#: ``(method, url, body, headers, timeout) -> (status, text, response_headers)``
#:
#: The response headers are part of the contract because ``Retry-After`` lives
#: there, and a sender that dropped them would silently turn a polite backoff
#: into a hammering one.
#:
#: A sender that returns only ``(status, text)`` is still accepted. That shape
#: was the whole contract before retrying existed, it is what the bots that
#: wrap this in an executor were written against, and breaking them to add a
#: feature they did not ask for would be the wrong trade for a package whose
#: entire job is not interrupting somebody's application.
Sender = Callable[
    [str, str, bytes | None, dict[str, str], float],
    "tuple[int, str, dict[str, str]] | tuple[int, str]",
]


def normalise_api_url(raw: str) -> str:
    """Accept whatever anyone put in a settings file and produce one shape.

    Six places in the sibling projects spell this differently - with ``/v1``,
    with ``/api/v1``, with and without a trailing slash. Normalising here means
    a stored setting from an older version keeps working instead of turning
    into a 404 that reads like a licence problem.
    """
    url = raw.strip().rstrip("/")
    url = _TRAILING_VERSION.sub("", url)
    return f"{url}{API_PATH}"


def _urllib_send(
    method: str, url: str, body: bytes | None, headers: dict[str, str], timeout: float
) -> tuple[int, str, dict[str, str]]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return (
                int(response.status),
                response.read().decode("utf-8"),
                {key.lower(): value for key, value in response.headers.items()},
            )
    except urllib.error.HTTPError as exc:
        # A refusal by the server is an answer, not a transport failure.
        return (
            int(exc.code),
            exc.read().decode("utf-8", errors="replace"),
            {key.lower(): value for key, value in exc.headers.items()},
        )
    except Exception as exc:  # noqa: BLE001 - URLError, socket.timeout, ssl errors
        raise NetworkError("The licence server could not be reached", exc) from exc


def _unpack(
    answer: tuple[int, str, dict[str, str]] | tuple[int, str],
) -> tuple[int, str, dict[str, str]]:
    """Accept a sender that reports headers, and one that does not."""
    if len(answer) == 3:
        status, text, headers = answer
        return status, text, headers
    status, text = answer
    return status, text, {}


def _query_string(query: dict[str, Any] | None) -> str:
    """Render query parameters, skipping the ones with nothing to say."""
    if not query:
        return ""
    pairs = [(key, str(value)) for key, value in query.items() if value is not None]
    return f"?{urllib.parse.urlencode(pairs)}" if pairs else ""


class Transport:
    def __init__(
        self,
        base_url: str,
        send: Sender | None = None,
        timeout: float = 15.0,
        *,
        retry: RetryPolicy = DEFAULT_RETRY,
        on_event: LicenseEventListener | None = None,
        sleep: Callable[[float], None] | None = None,
        random: Callable[[], float] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.base_url = base_url
        self._send: Sender = send or _urllib_send
        self.timeout = timeout
        self._retry = retry
        self._on_event = on_event
        self._sleep = sleep or time.sleep
        self._random = random
        self._now = now or (lambda: datetime.now(UTC))

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: Any = None,
        token: str | None = None,
        query: dict[str, Any] | None = None,
        timeout: float | None = None,
        retry: RetryPolicy | None = None,
    ) -> Any:
        """One request, retried according to the policy.

        The loop is deliberately flat rather than recursive: the budget and the
        attempt count both have to be visible in one place, or a policy change
        quietly stops applying to one of the two exits.
        """
        policy = retry or self._retry
        started = time.monotonic()
        url = f"{self.base_url}{path}{_query_string(query)}"

        headers = {"Accept": "application/json"}
        payload: bytes | None = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"

        attempt = 0
        while True:
            attempt += 1
            emit(self._on_event, "request.start", path=path, attempt=attempt)
            at = time.monotonic()

            try:
                answer = self._send(
                    method, url, payload, dict(headers), timeout or self.timeout
                )
                status, text, response_headers = _unpack(answer)
            except NetworkError as failure:
                wait = self._next_delay(attempt, policy, started, None)
                if wait is None:
                    emit(
                        self._on_event,
                        "request.failed",
                        path=path,
                        attempts=attempt,
                        status=None,
                        code="network",
                    )
                    # A failure to reach the server is not a licence problem.
                    # The caller falls back to the cache, which is the entire
                    # reason it exists.
                    raise failure
                emit(
                    self._on_event,
                    "request.retry",
                    path=path,
                    attempt=attempt,
                    status=None,
                    delay=wait,
                    reason="network",
                )
                self._sleep(wait)
                continue

            if 200 <= status < 300:
                emit(
                    self._on_event,
                    "request.ok",
                    path=path,
                    attempt=attempt,
                    status=status,
                    duration=time.monotonic() - at,
                )
                if status == 204 or not text:
                    return None
                try:
                    return json.loads(text)
                except ValueError:
                    return None

            if is_retryable_status(status):
                retry_after = parse_retry_after(
                    response_headers.get("retry-after"), self._now()
                )
                wait = self._next_delay(attempt, policy, started, retry_after)
                if wait is not None:
                    emit(
                        self._on_event,
                        "request.retry",
                        path=path,
                        attempt=attempt,
                        status=status,
                        delay=wait,
                        reason="retry-after"
                        if retry_after is not None
                        else f"status {status}",
                    )
                    self._sleep(wait)
                    continue

            raise self._to_error(status, text, response_headers, path, attempt)

    def _next_delay(
        self,
        attempt: int,
        policy: RetryPolicy,
        started: float,
        retry_after: float | None,
    ) -> float | None:
        """How long to wait before the next attempt, or ``None`` to give up."""
        if attempt > policy.attempts:
            return None

        if retry_after is not None:
            # The server asked for a specific delay. Honouring it is the
            # difference between a rate limit that lifts and one that gets
            # tightened - but a client blocked for ten minutes is worse than one
            # that uses its cache.
            if retry_after > policy.max_retry_after:
                return None
            wait = retry_after
        else:
            wait = backoff_seconds(attempt, policy, self._random)

        if (time.monotonic() - started) + wait > policy.budget:
            return None
        return wait

    def _to_error(
        self,
        status: int,
        text: str,
        headers: dict[str, str],
        path: str,
        attempt: int,
    ) -> ApiError:
        parsed: Any = None
        if text:
            try:
                parsed = json.loads(text)
            except ValueError:
                parsed = None

        error = (parsed or {}).get("error", {}) if isinstance(parsed, dict) else {}
        message = error.get("message") or f"The licence server answered {status}"
        code = error.get("code") or "api_error"
        # The API nests the structured detail under ``error``. Reading it from
        # the top level looks right and silently yields nothing - which turns a
        # 409 that names the occupied seats into one that says nothing.
        detail = error.get("detail")

        emit(
            self._on_event,
            "request.failed",
            path=path,
            attempts=attempt,
            status=status,
            code=code,
        )

        if status == 409 and code == "SeatLimitReached":
            return SeatLimitError(
                message,
                detail
                or {"seats": {"total": 0, "used": 0, "available": 0}, "active_seats": []},
            )

        if status == 429:
            return RateLimitError(
                message, parse_retry_after(headers.get("retry-after"), self._now())
            )

        return ApiError(message, status, code, detail)
