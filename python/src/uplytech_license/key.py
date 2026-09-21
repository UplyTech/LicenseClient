"""Licence key format, checked offline.

Mirrors ``app/core/license_keys.py`` in the API. The point of doing this on the
client is that a typo is rejected without a round trip - and without an
endpoint that answers "no such key", which would be a key oracle for anyone who
wanted to enumerate them::

    ULT-TPM-3F7K9-2QW8M-XZ4RB-W
    ^^^ ^^^ ^^^^^^^^^^^^^^^^^^ ^
    |   |   15 random symbols   check symbol
    |   product code
    brand prefix
"""

from __future__ import annotations

from .errors import InvalidKeyError

#: Crockford base32: no I, L, O or U.
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
ALPHABET_SIZE = len(ALPHABET)
BRAND_PREFIX = "ULT"
BODY_SYMBOLS = 15
GROUP_SIZE = 5

_VALUES = {char: index for index, char in enumerate(ALPHABET)}

#: What people actually type when reading a key off a screen.
_CONFUSABLES = {"I": "1", "L": "1", "O": "0", "U": "V"}


def normalise_key(raw: str) -> str:
    """Fold a typed key into ``<CODE><BODY><CHECK>``.

    The brand prefix is stripped rather than folded: ``ULT`` contains U and L,
    which the alphabet deliberately excludes. It is decoration, carries no
    information and stays out of the checksum - so a key typed without it still
    resolves to the same value.
    """
    compact = "".join(char for char in raw.upper() if char.isalnum())
    if compact.startswith(BRAND_PREFIX):
        compact = compact[len(BRAND_PREFIX) :]
    return "".join(_CONFUSABLES.get(char, char) for char in compact)


def format_key(product_code: str, body: str, check: str) -> str:
    """Render the display form with its dashes."""
    groups = [body[i : i + GROUP_SIZE] for i in range(0, len(body), GROUP_SIZE)]
    return "-".join([BRAND_PREFIX, product_code, *groups, check])


def check_symbol(payload: str) -> str:
    """Luhn mod 32 over the alphabet.

    Catches every single wrong character and most transpositions, which is what
    actually happens when a key is read aloud or retyped.
    """
    total = 0
    factor = 2
    for char in reversed(payload):
        value = _VALUES.get(char)
        if value is None:
            raise InvalidKeyError(f"Character {char!r} is not part of the key alphabet")
        addend = factor * value
        addend = (addend // ALPHABET_SIZE) + (addend % ALPHABET_SIZE)
        total += addend
        factor = 1 if factor == 2 else 2
    remainder = total % ALPHABET_SIZE
    return ALPHABET[(ALPHABET_SIZE - remainder) % ALPHABET_SIZE]


def has_valid_check_symbol(normalised: str) -> bool:
    if len(normalised) < 2:
        return False
    try:
        return check_symbol(normalised[:-1]) == normalised[-1]
    except InvalidKeyError:
        return False


def parse_key(raw: str) -> tuple[str, str]:
    """Validate a typed key and return ``(product_code, normalised)``.

    Raises :class:`InvalidKeyError` for anything malformed, so an activation
    dialog can say "that looks like a typo" the moment the field loses focus.
    """
    normalised = normalise_key(raw)

    if len(normalised) <= BODY_SYMBOLS + 1:
        raise InvalidKeyError("Key is too short")

    code = normalised[: len(normalised) - BODY_SYMBOLS - 1]
    if not 1 <= len(code) <= 4:
        raise InvalidKeyError("Key has an implausible product code length")

    if not has_valid_check_symbol(normalised):
        raise InvalidKeyError("Key check symbol does not match - likely a typo")

    return code, normalised


def is_valid_key(raw: str) -> bool:
    """True when the key is well formed. For live validation while typing."""
    try:
        parse_key(raw)
    except InvalidKeyError:
        return False
    return True
