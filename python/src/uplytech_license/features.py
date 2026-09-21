"""Feature lookup.

The application asks "may I show the time tracking?" and gets one boolean.
Patterns exist so a tier can grant a whole area without listing every switch in
it, and so adding a feature to an area does not require reissuing every licence
that already covers it.
"""

from __future__ import annotations

from collections.abc import Sequence


def has_feature(granted: Sequence[str], feature: str) -> bool:
    """Does the granted set cover this feature?

    Matching is exact unless a granted entry ends in ``*``, which covers any
    suffix - including the empty one, so ``export.*`` answers ``export.`` as
    well as ``export.csv``. It does not cover ``export``, and it does not cover
    ``exportable``: a wildcard is a prefix rule, not a substring search.

    The wildcard is only ever on the granted side. A query is always a literal
    name, otherwise an application could ask "do I have anything?" and get a
    yes.
    """
    if not feature:
        return False

    for entry in granted:
        if entry in ("*", feature):
            return True
        if entry.endswith("*"):
            stem = entry[:-1]
            if stem and feature.startswith(stem):
                return True
    return False


def granted_from(granted: Sequence[str], wanted: Sequence[str]) -> list[str]:
    """Every feature in ``wanted`` that the licence covers."""
    return [feature for feature in wanted if has_feature(granted, feature)]


class FeatureIndex:
    """The same rules, prepared once for repeated questions.

    A desktop application asks ``has_feature`` from inside menu-enable code and
    render paths - hundreds of times a second, with the same answer every time.
    :func:`has_feature` walks the granted list and calls ``endswith`` on each
    entry for every one of those. That is nothing at ten entries and measurable
    at a few hundred, which a tier with per-report or per-integration switches
    reaches.

    The index costs one pass over the list and then answers exact matches from a
    set. Only the wildcard entries are still scanned, and there are rarely more
    than a handful of those.

    It is built from a snapshot of the granted list. A licence whose features
    change gets a new index - see how :class:`LicenseClient` rebuilds it when
    the snapshot changes rather than mutating one.
    """

    __slots__ = ("_everything", "_exact", "_prefixes")

    def __init__(self, granted: Sequence[str]) -> None:
        everything = False
        exact: set[str] = set()
        prefixes: list[str] = []

        for entry in granted:
            if entry == "*":
                everything = True
                continue
            if entry.endswith("*"):
                stem = entry[:-1]
                # A bare ``*`` was handled above; an entry that is only a star
                # after trimming would otherwise become an empty prefix
                # matching everything.
                if stem:
                    prefixes.append(stem)
                continue
            exact.add(entry)

        #: True when the licence grants everything, which short-circuits every
        #: query.
        self._everything = everything
        self._exact = frozenset(exact)
        self._prefixes = tuple(prefixes)

    def has(self, feature: str) -> bool:
        if not feature:
            return False
        if self._everything:
            return True
        if feature in self._exact:
            return True
        return any(feature.startswith(prefix) for prefix in self._prefixes)

    def granted(self, wanted: Sequence[str]) -> list[str]:
        """Every feature in ``wanted`` that the licence covers."""
        return [feature for feature in wanted if self.has(feature)]
