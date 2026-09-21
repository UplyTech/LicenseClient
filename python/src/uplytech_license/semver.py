"""Semantic version comparison, for the one licence field nothing enforced.

``max_version`` on a licence means "usable, but not past this version" - the
update window a perpetual licence buys. The server stores it and puts it in
every status response; until this module existed the client kept it in the
snapshot and never looked at it, so a perpetual licence sold for the 1.x line
silently covered 4.0 as well.

Why not compare the strings. ``"1.10.0" < "1.9.0"`` is true for a string and
false for a version, and the first time it matters is the tenth minor release -
by which point the mistake is years old and every affected customer is already
running a build they did not buy.

The precedence rules here are Semantic Versioning 2.0.0, which the sibling
packages and the API already follow:

* major, minor and patch compare numerically, left to right
* a pre-release is *lower* than the release it precedes: ``2.0.0-rc.1 < 2.0.0``
* pre-release identifiers compare left to right; numeric ones numerically,
  alphanumeric ones by ASCII, and numeric sorts below alphanumeric
* a longer pre-release outranks the prefix it extends: ``1.0.0-a < 1.0.0-a.1``
* build metadata after ``+`` is ignored entirely

Pinned by ``shared/testcases/version.json``, because two editions that order
versions differently would lock a customer out on one platform and not the
other - which is the failure mode this package exists to avoid.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = [
    "ParsedVersion",
    "compare_parsed",
    "compare_versions",
    "is_valid_version",
    "parse_version",
    "version_within",
]

#: ``1.2.3``, ``v1.2.3``, ``1.2``, ``1``, with an optional ``-pre`` and ``+build``.
#:
#: A leading ``v`` is accepted because half the world writes tags that way and a
#: licence that refused ``v1.2.3`` would be refusing the same version it allows.
_VERSION = re.compile(
    r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"
)


@dataclass(frozen=True, slots=True)
class ParsedVersion:
    """A parsed version. ``prerelease`` is empty for a release."""

    major: int
    minor: int
    patch: int
    #: Dot-separated identifiers after ``-``, already split.
    prerelease: tuple[str | int, ...] = ()


def parse_version(raw: str | None) -> ParsedVersion | None:
    """Parse a version, or return ``None`` for anything that is not one.

    ``None`` rather than an exception: the callers here are deciding whether to
    lock somebody out, and every one of them treats "cannot tell" as "do not
    lock". An exception would invite a ``try`` that swallows it into the wrong
    answer.
    """
    if not isinstance(raw, str):
        return None
    match = _VERSION.match(raw.strip())
    if match is None:
        return None

    major, minor, patch, prerelease = match.groups()
    identifiers: tuple[str | int, ...] = ()
    if prerelease is not None:
        identifiers = tuple(
            int(part) if part.isdigit() else part for part in prerelease.split(".")
        )
    return ParsedVersion(
        major=int(major),
        minor=0 if minor is None else int(minor),
        patch=0 if patch is None else int(patch),
        prerelease=identifiers,
    )


def is_valid_version(raw: str | None) -> bool:
    """True when the string is a version this module can order."""
    return parse_version(raw) is not None


def _compare_prerelease(left: tuple[str | int, ...], right: tuple[str | int, ...]) -> int:
    # A release outranks any pre-release of the same numbers, so an empty tuple
    # is the *highest* value here - the one place this comparison inverts.
    if not left and not right:
        return 0
    if not left:
        return 1
    if not right:
        return -1

    for a, b in zip(left, right, strict=False):
        if a == b:
            continue
        a_numeric = isinstance(a, int)
        b_numeric = isinstance(b, int)
        # "Numeric identifiers always have lower precedence than alphanumeric
        # identifiers" - so 1.0.0-1 < 1.0.0-alpha, which reads backwards until
        # you remember that alpha is a word and 1 is a build counter.
        if a_numeric and not b_numeric:
            return -1
        if not a_numeric and b_numeric:
            return 1
        return -1 if a < b else 1  # type: ignore[operator]

    # Everything shared is equal: the longer tuple wins, because it is more
    # specific. 1.0.0-alpha < 1.0.0-alpha.1
    if len(left) == len(right):
        return 0
    return -1 if len(left) < len(right) else 1


def compare_parsed(a: ParsedVersion, b: ParsedVersion) -> int:
    """:func:`compare_versions` for two already-parsed versions."""
    if a.major != b.major:
        return -1 if a.major < b.major else 1
    if a.minor != b.minor:
        return -1 if a.minor < b.minor else 1
    if a.patch != b.patch:
        return -1 if a.patch < b.patch else 1
    return _compare_prerelease(a.prerelease, b.prerelease)


def compare_versions(left: str, right: str) -> int:
    """Order two versions: ``-1``, ``0`` or ``1``.

    Raises for an unparseable input, unlike :func:`parse_version`. Callers that
    cannot afford to raise use :func:`version_within`, which decides what an
    unreadable version means.
    """
    a = parse_version(left)
    b = parse_version(right)
    if a is None:
        raise TypeError(f"Not a version: {left!r}")
    if b is None:
        raise TypeError(f"Not a version: {right!r}")
    return compare_parsed(a, b)


def version_within(app_version: str | None, max_version: str | None) -> bool:
    """Is this build inside the licence's update window?

    The three ways it answers ``True`` are all deliberate:

    * **No max_version.** A subscription has no update window; there is nothing
      to be past.
    * **An unreadable max_version.** That is our data being wrong, and locking a
      paying customer out over a malformed field in our own database would be
      indefensible.
    * **An unreadable app_version.** Same direction, different reason: a build
      that reports ``"dev"`` or a commit hash is a developer's build or a
      distribution that rewrote the string, and neither is a licence violation.

    Failing open here is not a hole to be closed. ``app_version`` is sent to the
    server on every activation and heartbeat, and the server enforces the same
    window with data the client cannot edit. Anybody willing to patch the
    version string in their own binary can equally patch out this call -
    client-side checks make the honest path work offline, they do not stop the
    dishonest one.
    """
    maximum = parse_version(max_version)
    if maximum is None:
        return True
    app = parse_version(app_version)
    if app is None:
        return True
    return compare_parsed(app, maximum) <= 0
