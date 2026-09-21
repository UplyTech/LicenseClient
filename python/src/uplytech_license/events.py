"""The one place this library says out loud what it just did.

Everything else here fails quietly on purpose. A corrupt cache is discarded
without a word, because the only useful response is the activation dialog. A
network failure inside the offline window is not an error at all. A retry
happens and nobody is told. Those are the right behaviours for the customer
sitting in front of the application - and they are exactly the behaviours that
make a support ticket unanswerable, because the one machine where the problem
happens is the one machine nobody can attach a debugger to.

So: a single optional callback. No logger interface to implement, no dependency,
no format to agree on. It hands over a small record a caller can match on,
forward to Sentry, or drop into ``logging``.

**Nothing here ever carries a credential**, a token, a licence key or a raw
hardware value. Fingerprints appear only as the already-hashed form, and only
where a support engineer needs to compare two of them.
"""

from __future__ import annotations

import contextlib
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

__all__ = ["LicenseEvent", "LicenseEventListener", "emit"]


@dataclass(frozen=True, slots=True)
class LicenseEvent:
    """Something the client did, in a form a log line can be built from.

    ``type`` is one of a closed set, mirroring the TypeScript edition's union so
    a support engineer reading logs from a desktop application and from a bot
    sees the same words:

    ``cache.loaded`` ``cache.missing`` ``cache.discarded`` ``cache.written``
    ``request.start`` ``request.ok`` ``request.retry`` ``request.failed``
    ``token.refreshed`` ``signature.verified`` ``signature.rejected``
    ``clock.rolled_back`` ``state.changed``
    """

    type: str
    data: dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:
        if not self.data:
            return self.type
        rendered = " ".join(f"{key}={value!r}" for key, value in sorted(self.data.items()))
        return f"{self.type} {rendered}"


#: ``(event) -> None``. Anything it raises is swallowed; see :func:`emit`.
LicenseEventListener = Callable[[LicenseEvent], None]


def emit(listener: LicenseEventListener | None, type_: str, **data: Any) -> None:
    """Call a listener without letting it break the caller.

    A listener that raises - a Sentry client mid-initialisation, a log handler
    with a full disk - must not turn into a licence failure. Observability is
    never allowed to be the thing that stops an application starting.
    """
    if listener is None:
        return
    # Deliberately swallowed, and deliberately not re-reported through the same
    # listener that just failed.
    with contextlib.suppress(Exception):
        listener(LicenseEvent(type=type_, data=data))
