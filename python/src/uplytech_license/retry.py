"""When to try a licence request again, and how long to wait first.

A licence client is not a general HTTP client, and the difference decides
everything here. It makes a handful of calls, at start-up and every few hours,
on whatever connection the customer happens to have - a hotel wifi that drops
the first TLS handshake, a laptop resuming from sleep, a server being restarted
behind a load balancer. Every one of those is a transient failure that the cache
would paper over, but papering over it means the customer's licence quietly
stops refreshing until the offline window runs out on a train.

One retry turns most of those into nothing at all.

The rules are deliberately narrow:

* **Only transport failures and 5xx.** A 401 means the token is stale and the
  caller has a specific answer for that. A 403 or 409 is a decision. Retrying a
  decision is how a seat-limit dialog turns into three seat-limit dialogs.
* **429 is honoured, not fought.** The server's ``Retry-After`` wins over the
  computed backoff, up to a cap - a client that ignores it is the reason rate
  limits get tightened for everybody.
* **Full jitter.** Ten thousand bots restarted by one deployment must not retry
  in lockstep; without jitter the retry *is* the outage.
* **A budget, not just a count.** Total time is what a user experiences, and an
  application blocked at start-up has to come back in a bounded time or the
  correct behaviour is to carry on with the cache.
"""

from __future__ import annotations

import random as _random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime

__all__ = [
    "DEFAULT_RETRY",
    "NO_RETRY",
    "RetryPolicy",
    "backoff_seconds",
    "is_retryable_status",
    "parse_retry_after",
]


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """How a request that failed should be treated."""

    #: Attempts after the first. ``0`` disables retrying entirely.
    attempts: int = 2
    #: First backoff step in seconds. Doubles each attempt.
    base_delay: float = 0.25
    #: Upper bound for a single wait, before jitter.
    max_delay: float = 4.0
    #: Upper bound for everything, including the requests themselves.
    budget: float = 20.0
    #: Longest ``Retry-After`` this client will sit out rather than give up.
    #: Beyond half a minute the honest thing is to stop blocking and let the
    #: cache answer. The application will check in again later anyway.
    max_retry_after: float = 30.0


DEFAULT_RETRY = RetryPolicy()

#: Retrying disabled, for a caller that wants exactly one attempt.
NO_RETRY = RetryPolicy(attempts=0)


def is_retryable_status(status: int) -> bool:
    """Whether a status code is worth trying again.

    408 and 425 are the server saying "too slow" and "too early", 429 is a rate
    limit, and 5xx is the server's own fault. Nothing else: a 4xx is an answer.
    """
    return status in (408, 425, 429) or status >= 500


def parse_retry_after(header: str | None, now: datetime) -> float | None:
    """Parse a ``Retry-After`` header. Seconds or an HTTP date, per RFC 9110.

    Returns ``None`` for anything unparseable rather than guessing - a wrong
    guess either hammers a server that asked for room or blocks a user for an
    hour. A negative or absurd value is clamped by the caller, not here, so the
    raw intent stays visible to a test.
    """
    if not header:
        return None
    trimmed = header.strip()
    if not trimmed:
        return None

    if trimmed.isdigit():
        return float(trimmed)

    try:
        # Raises on a malformed date; older Pythons returned None instead, and
        # the annotation says it cannot - so the check is a runtime one only.
        when = parsedate_to_datetime(trimmed)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=now.tzinfo)
    return max(0.0, (when - now).total_seconds())


def backoff_seconds(
    attempt: int,
    policy: RetryPolicy = DEFAULT_RETRY,
    random: Callable[[], float] | None = None,
) -> float:
    """How long to wait before attempt number ``attempt`` (1-based).

    Exponential with full jitter: the wait is uniform in ``[0, cap]`` rather
    than exactly ``cap``. Sleeping the full backoff is what makes ten thousand
    clients retry together; sleeping a uniform fraction of it spreads them out,
    and the expected wait is half as long into the bargain.
    """
    exponential: float = policy.base_delay * float(2 ** max(0, attempt - 1))
    cap: float = min(exponential, policy.max_delay)
    draw: Callable[[], float] = _random.random if random is None else random
    return draw() * cap
