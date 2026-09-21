"""Deterministic JSON, byte-for-byte identical to the API's
``app/core/license_signing.py:canonical_json`` and to the TypeScript edition.

Keys sorted, no whitespace, unicode left as UTF-8. The shared vectors in
``shared/testcases/canonical-json.json`` pin the exact output; if the two
editions ever disagree, every signature check silently fails and nobody can
tell why.
"""

from __future__ import annotations

import json
from typing import Any

from .errors import CanonicalJsonError

#: JavaScript loses precision past this, so the TypeScript edition refuses
#: anything larger. Python would happily serialise it, and the two would then
#: accept different inputs - which is exactly the kind of quiet divergence the
#: shared vectors exist to prevent.
MAX_SAFE_INTEGER = 2**53 - 1


def _reject_floats(value: Any, path: str) -> None:
    """Walk the value and refuse anything the two editions cannot agree on.

    Python renders ``1.0`` where JavaScript renders ``1``, and no amount of
    care reconciles that in general. Licence payloads only ever carry strings,
    integers, booleans, null, arrays and objects, so refusing a float turns a
    signature that would quietly stop verifying into an error at the point
    where the value was introduced.
    """
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalJsonError(
                f"{path}: {value} is beyond the safe integer range and would lose precision"
            )
        return
    if isinstance(value, float):
        raise CanonicalJsonError(
            f"{path}: only integers are allowed, got {value!r} - "
            "a float cannot be serialised identically in both editions"
        )
    if isinstance(value, list | tuple):
        for index, item in enumerate(value):
            _reject_floats(item, f"{path}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonicalJsonError(f"{path}: object keys must be strings, got {key!r}")
            _reject_floats(item, f"{path}.{key}")
        return
    raise CanonicalJsonError(f"{path}: {type(value).__name__} cannot be serialised")


def canonical_json(value: Any) -> str:
    """Serialise to the canonical string form."""
    _reject_floats(value, "$")
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def canonical_json_bytes(value: Any) -> bytes:
    """Serialise to the canonical UTF-8 bytes - what actually gets signed."""
    return canonical_json(value).encode("utf-8")
