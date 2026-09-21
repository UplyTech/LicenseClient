#!/usr/bin/env python3
"""The wheel contains the things a test suite cannot see it missing.

``py.typed`` is the one that matters most: without it every calling project
types the whole library as ``Any``, ``mypy --strict`` in the *caller* goes quiet,
and nothing in this repository notices - the suites import from ``src/``, not
from the wheel.

Usage: ``python check_wheel.py <directory containing the wheel>``
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

REQUIRED_FILES = ("uplytech_license/py.typed", "uplytech_license/__init__.py")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: check_wheel.py <dist directory>", file=sys.stderr)
        return 2

    wheels = sorted(Path(argv[1]).glob("*.whl"))
    if not wheels:
        print(f"::error::no wheel found in {argv[1]}", file=sys.stderr)
        return 1
    if len(wheels) > 1:
        print(f"::error::expected one wheel, found {len(wheels)}", file=sys.stderr)
        return 1

    names = zipfile.ZipFile(wheels[0]).namelist()
    missing = [name for name in REQUIRED_FILES if name not in names]

    # hatchling files the licence under dist-info/licenses/, so match on the
    # tail rather than on a full path that could reasonably move.
    if not any(name.endswith("LICENSE") for name in names):
        missing.append("LICENSE")

    if missing:
        print(f"::error::{wheels[0].name} is missing: {', '.join(missing)}", file=sys.stderr)
        return 1

    print(f"ok - {wheels[0].name} carries py.typed and the licence")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
