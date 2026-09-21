"""Where the sealed cache lives.

The contents are already encrypted and authenticated before they reach a
Storage, so an implementation only has to move bytes. It does not have to be a
secure location - that is the point of sealing them.
"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path
from typing import Protocol


class Storage(Protocol):
    def read(self) -> bytes | None: ...

    def write(self, data: bytes) -> None: ...

    def clear(self) -> None: ...


class FileStorage:
    """A file on disk, written atomically.

    The temporary file plus rename matters: a licence cache truncated by a
    power cut halfway through a write would leave the application unable to
    start, and "reinstall to fix it" is not an acceptable answer to a flat
    battery.
    """

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)

    def read(self) -> bytes | None:
        try:
            return self.path.read_bytes()
        except OSError:
            # A missing file, a permission problem, a corrupt directory entry -
            # all of it means the same thing to the caller: not activated.
            return None

    def write(self, data: bytes) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(f"{self.path.suffix}.{os.getpid()}.tmp")
        temporary.write_bytes(data)
        # Windows and some network shares do not implement this. The cache is
        # sealed either way, so it is a nicety, not a requirement.
        with contextlib.suppress(OSError):
            temporary.chmod(0o600)
        os.replace(temporary, self.path)

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)


class MemoryStorage:
    """For tests, and for a process that deliberately keeps nothing."""

    def __init__(self) -> None:
        self._data: bytes | None = None

    def read(self) -> bytes | None:
        return self._data

    def write(self, data: bytes) -> None:
        self._data = bytes(data)

    def clear(self) -> None:
        self._data = None
