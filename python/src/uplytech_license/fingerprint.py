"""Device fingerprints - the arithmetic.

Every component is hashed before it leaves the machine. Host names, MAC
addresses and user names are personal data; the server has no business holding
them and this library never sends them.

Nothing here touches the operating system. The probing lives in ``probe.py``,
which cannot be tested on a machine that is not the one it is probing - so
keeping the two apart is what makes this module provable against the shared
vectors.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

#: What a component is worth as evidence.
#:
#: Mirrors ``COMPONENT_WEIGHTS`` in the API, which is what actually decides
#: whether a changed machine rebinds its seat or consumes a new one. The
#: machine id and the mainboard survive almost everything; the network address
#: barely survives a train journey.
COMPONENT_WEIGHTS: dict[str, int] = {
    "machine_id": 3,
    "board": 3,
    "disk": 2,
    "cpu": 1,
    "mac": 1,
    "user": 1,
    "install_id": 1,
}

TOTAL_WEIGHT = sum(COMPONENT_WEIGHTS.values())

#: The components that go into the combined fingerprint.
#:
#: ``install_id`` is left out on purpose: it changes on a reinstall, and the
#: seat should survive one. It still counts as evidence during a rebind.
STABLE_COMPONENTS = ("machine_id", "board", "disk", "cpu", "mac", "user")

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def hash_component(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_components(raw: dict[str, str]) -> dict[str, str]:
    """Hash a map of raw values in one go."""
    return {name: hash_component(value) for name, value in raw.items() if value}


def combine_fingerprint(hashed_components: dict[str, str]) -> str:
    """Combine already-hashed components into the fingerprint.

    Sorted by component name and joined with a separator, so the order in which
    the machine happened to report them is irrelevant. Unknown component names
    are ignored: a newer client version reporting something extra must not
    shift the fingerprint of installations that have been running for a year.
    """
    names = sorted(
        name
        for name, value in hashed_components.items()
        if name in STABLE_COMPONENTS and value
    )
    joined = "|".join(hashed_components[name] for name in names)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class FingerprintMatch:
    weight: int
    matched: tuple[str, ...]
    changed: tuple[str, ...]

    @property
    def stability(self) -> int:
        """Match strength as a percentage of the maximum weight."""
        return round(self.weight * 100 / TOTAL_WEIGHT) if TOTAL_WEIGHT else 0


def compare_components(stored: dict[str, str], presented: dict[str, str]) -> FingerprintMatch:
    """Weighted comparison of two component maps.

    A component missing on either side counts as neither a match nor a
    mismatch. An older client version simply does not report everything, and
    punishing that would make every upgrade look like a new machine.
    """
    matched: list[str] = []
    changed: list[str] = []
    weight = 0

    for component, component_weight in COMPONENT_WEIGHTS.items():
        left = stored.get(component)
        right = presented.get(component)
        if not left or not right:
            continue
        if left == right:
            matched.append(component)
            weight += component_weight
        else:
            changed.append(component)

    return FingerprintMatch(weight=weight, matched=tuple(matched), changed=tuple(changed))


def is_valid_fingerprint(value: str) -> bool:
    """A SHA-256 digest in lower-case hex."""
    return bool(_HEX64.match(value))
