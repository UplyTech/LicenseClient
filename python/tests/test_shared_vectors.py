"""The contract between the Python and the TypeScript edition, and between
both of them and the API.

These vectors live in ``../../shared/testcases``. Four of them are generated
from the API's own modules, which is what makes this a contract rather than a
restatement of what this file happens to do. Never regenerate a vector to make
a test pass: if a vector changes, the wire format changed, and existing
installations stop working.

The vector files use the camelCase spelling throughout - one spelling keeps the
diffs readable - and this module maps them onto the snake_case API.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import fields
from datetime import datetime
from functools import cmp_to_key
from pathlib import Path
from typing import Any

import pytest

from uplytech_license import (
    COMPONENT_WEIGHTS,
    TOTAL_WEIGHT,
    CacheError,
    CanonicalJsonError,
    InvalidKeyError,
    LicenseSnapshot,
    SignatureError,
    canonical_json,
    canonical_json_bytes,
    check_clock,
    check_symbol,
    combine_fingerprint,
    compare_components,
    compare_versions,
    derive_cache_key,
    evaluate,
    format_key,
    has_feature,
    hash_component,
    hash_components,
    normalise_key,
    open_sealed,
    parse_key,
    parse_version,
    seal_with_nonce,
    verify_envelope,
    version_within,
)

VECTOR_DIR = Path(__file__).resolve().parents[2] / "shared" / "testcases"
SUPPORTED_FORMAT_VERSION = 1


def load(name: str) -> dict[str, Any]:
    data = json.loads((VECTOR_DIR / f"{name}.json").read_text(encoding="utf-8"))
    assert data["formatVersion"] == SUPPORTED_FORMAT_VERSION, f"{name}.json format version"
    return data


def ids(cases: list[dict[str, Any]]) -> list[str]:
    return [case["id"] for case in cases]


# -----------------------------------------------------------------------------
# canonical json
# -----------------------------------------------------------------------------

CANONICAL = load("canonical-json")


@pytest.mark.parametrize("case", CANONICAL["cases"], ids=ids(CANONICAL["cases"]))
def test_canonical_json(case: dict[str, Any]) -> None:
    assert canonical_json(case["value"]) == case["expect"]
    assert (
        base64.b64encode(canonical_json_bytes(case["value"])).decode()
        == (case["expectBytesBase64"])
    )


def test_canonical_json_refuses_a_float() -> None:
    # Python renders 1.0, JavaScript renders 1. Failing loudly beats a
    # signature that silently stops verifying.
    with pytest.raises(CanonicalJsonError, match="only integers"):
        canonical_json({"ratio": 0.5})


def test_canonical_json_refuses_an_unsafe_integer() -> None:
    # The TypeScript edition cannot represent this. Both have to refuse the
    # same inputs or they accept different payloads.
    with pytest.raises(CanonicalJsonError, match="safe integer"):
        canonical_json({"n": 2**53})


# -----------------------------------------------------------------------------
# keys
# -----------------------------------------------------------------------------

KEYS = load("key")


def test_alphabet_matches_the_api() -> None:
    from uplytech_license import ALPHABET

    assert KEYS["alphabet"] == ALPHABET
    # I, L, O and U are absent on purpose: the first three are confusable with
    # 1, 1 and 0, and U keeps a random key from spelling something unfortunate.
    for character in "ILOU":
        assert character not in ALPHABET


@pytest.mark.parametrize("case", KEYS["validKeys"], ids=ids(KEYS["validKeys"]))
def test_valid_keys(case: dict[str, Any]) -> None:
    assert check_symbol(f"{case['productCode']}{case['body']}") == case["checkSymbol"]
    assert (
        format_key(case["productCode"], case["body"], case["checkSymbol"]) == case["display"]
    )
    assert parse_key(case["display"]) == (case["productCode"], case["normalised"])


@pytest.mark.parametrize("case", KEYS["normaliseCases"], ids=ids(KEYS["normaliseCases"]))
def test_normalisation(case: dict[str, Any]) -> None:
    assert normalise_key(case["input"]) == case["expect"]


@pytest.mark.parametrize("case", KEYS["invalidKeys"], ids=ids(KEYS["invalidKeys"]))
def test_invalid_keys(case: dict[str, Any]) -> None:
    with pytest.raises(InvalidKeyError) as info:
        parse_key(case["input"])
    # The message is part of the contract: it is what the activation dialog
    # shows, and it must say "typo", not "unknown key".
    assert str(info.value) == case["message"]


# -----------------------------------------------------------------------------
# signatures
# -----------------------------------------------------------------------------

SIGNATURES = load("signature")
PUBLIC_KEYS = {SIGNATURES["keyId"]: SIGNATURES["publicKey"]}


def test_a_genuine_envelope_verifies() -> None:
    assert (
        verify_envelope(SIGNATURES["valid"]["envelope"], PUBLIC_KEYS)
        == (SIGNATURES["valid"]["expectPayload"])
    )


@pytest.mark.parametrize("case", SIGNATURES["invalid"], ids=ids(SIGNATURES["invalid"]))
def test_refused_envelopes(case: dict[str, Any]) -> None:
    with pytest.raises(SignatureError):
        verify_envelope(case["envelope"], PUBLIC_KEYS)


def test_no_known_key_at_all() -> None:
    with pytest.raises(SignatureError, match="Unknown signing key id"):
        verify_envelope(SIGNATURES["valid"]["envelope"], {})


# -----------------------------------------------------------------------------
# cache encryption
# -----------------------------------------------------------------------------

CRYPTO = load("crypto")


@pytest.mark.parametrize("case", CRYPTO["hkdfCases"], ids=ids(CRYPTO["hkdfCases"]))
def test_key_derivation(case: dict[str, Any]) -> None:
    derived = derive_cache_key(case["fingerprint"], case["productSlug"])
    assert base64.b64encode(derived).decode() == case["expectKeyBase64"]


def test_sealing_produces_the_same_bytes_as_the_typescript_edition() -> None:
    case = CRYPTO["sealCase"]
    sealed = seal_with_nonce(
        case["plaintext"].encode("utf-8"),
        case["fingerprint"],
        case["productSlug"],
        base64.b64decode(case["nonceBase64"]),
    )
    assert base64.b64encode(sealed).decode() == case["expectCiphertextBase64"]


def test_opening_reads_back_what_was_written() -> None:
    case = CRYPTO["sealCase"]
    opened = open_sealed(
        base64.b64decode(case["expectCiphertextBase64"]),
        case["fingerprint"],
        case["productSlug"],
        base64.b64decode(case["nonceBase64"]),
    )
    assert opened.decode("utf-8") == case["plaintext"]


@pytest.mark.parametrize("case", CRYPTO["openFailures"], ids=ids(CRYPTO["openFailures"]))
def test_opening_refuses(case: dict[str, Any]) -> None:
    with pytest.raises(CacheError):
        open_sealed(
            base64.b64decode(case["ciphertextBase64"]),
            case["fingerprint"],
            case["productSlug"],
            base64.b64decode(case["nonceBase64"]),
        )


# -----------------------------------------------------------------------------
# fingerprints
# -----------------------------------------------------------------------------

FINGERPRINTS = load("fingerprint")


def test_weights_match_the_server() -> None:
    # If these drift, the client predicts a rebind the server will not make -
    # and the customer is told they kept a seat they actually lost.
    assert FINGERPRINTS["weights"] == COMPONENT_WEIGHTS
    assert FINGERPRINTS["totalWeight"] == TOTAL_WEIGHT


@pytest.mark.parametrize("case", FINGERPRINTS["hashCases"], ids=ids(FINGERPRINTS["hashCases"]))
def test_component_hashing(case: dict[str, Any]) -> None:
    assert hash_component(case["input"]) == case["expect"]


@pytest.mark.parametrize(
    "case", FINGERPRINTS["combineCases"], ids=ids(FINGERPRINTS["combineCases"])
)
def test_combining(case: dict[str, Any]) -> None:
    assert combine_fingerprint(hash_components(case["components"])) == case["expect"]


@pytest.mark.parametrize(
    "case", FINGERPRINTS["compareCases"], ids=ids(FINGERPRINTS["compareCases"])
)
def test_comparison(case: dict[str, Any]) -> None:
    match = compare_components(case["stored"], case["presented"])
    assert match.weight == case["expect"]["weight"]
    assert list(match.matched) == case["expect"]["matched"]
    assert list(match.changed) == case["expect"]["changed"]


# -----------------------------------------------------------------------------
# features
# -----------------------------------------------------------------------------

FEATURES = load("features")


@pytest.mark.parametrize("case", FEATURES["cases"], ids=ids(FEATURES["cases"]))
def test_features(case: dict[str, Any]) -> None:
    assert has_feature(case["granted"], case["query"]) is case["expect"]


# -----------------------------------------------------------------------------
# state machine
# -----------------------------------------------------------------------------


def _snake(camel: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", camel).lower()


#: camelCase vector spelling -> snake_case snapshot field, derived rather than
#: listed. A hand-maintained whitelist is the wrong shape here: a vector field
#: nobody added to it is silently dropped, and the test then passes because the
#: value never reached the code under test. That is exactly how the update
#: window's first vectors "passed" against an evaluator that never saw a
#: maxVersion.
CAMEL_TO_SNAKE = {
    "".join(
        part if index == 0 else part.title()
        for index, part in enumerate(field.name.split("_"))
    ): field.name
    for field in fields(LicenseSnapshot)
}


def snapshot_from(vector: dict[str, Any] | None) -> LicenseSnapshot | None:
    """Build a snapshot from a vector, refusing any field it does not know.

    Loudly, on purpose. Silently ignoring an unknown key turns a typo in a
    vector file into a green test.
    """
    if vector is None:
        return None
    unknown = sorted(set(vector) - set(CAMEL_TO_SNAKE))
    assert not unknown, (
        f"vector uses fields LicenseSnapshot does not have: {unknown}. "
        f"Known: {sorted(CAMEL_TO_SNAKE)}"
    )
    return LicenseSnapshot(
        **{CAMEL_TO_SNAKE[key]: value for key, value in vector.items() if value is not None}
    )


def run_state_case(case: dict[str, Any]) -> None:
    result = evaluate(
        snapshot_from(case["snapshot"]),
        datetime.fromisoformat(case["now"]),
        fingerprint=case.get("fingerprint"),
        app_version=case.get("appVersion"),
    )
    assert result.state.value == case["expect"]["state"]
    assert result.reason == case["expect"]["reason"]
    assert result.can_run is case["expect"]["canRun"]
    if "shouldCheckIn" in case["expect"]:
        assert result.should_check_in is case["expect"]["shouldCheckIn"]


STATES = load("states")


@pytest.mark.parametrize("case", STATES["cases"], ids=ids(STATES["cases"]))
def test_states(case: dict[str, Any]) -> None:
    run_state_case(case)


# -----------------------------------------------------------------------------
# clock
# -----------------------------------------------------------------------------

CLOCK = load("clock")


@pytest.mark.parametrize("case", CLOCK["cases"], ids=ids(CLOCK["cases"]))
def test_clock(case: dict[str, Any]) -> None:
    result = check_clock(
        datetime.fromisoformat(case["now"]),
        case["clockHighWater"],
        CLOCK["toleranceHours"],
    )
    assert result.rolled_back is case["expect"]["rolledBack"]
    assert result.new_high_water == datetime.fromisoformat(case["expect"]["newHighWater"])


@pytest.mark.parametrize("case", CLOCK["stateCases"], ids=ids(CLOCK["stateCases"]))
def test_clock_states(case: dict[str, Any]) -> None:
    run_state_case(case)


# -----------------------------------------------------------------------------
# version
# -----------------------------------------------------------------------------

VERSION = load("version")


@pytest.mark.parametrize("case", VERSION["compare"], ids=ids(VERSION["compare"]))
def test_version_compare(case: dict[str, Any]) -> None:
    assert compare_versions(case["left"], case["right"]) == case["expect"]
    # Antisymmetry, for free, on every case: an implementation that gets the
    # ordering right in one direction and not the other is worse than one that
    # is wrong both ways, because half the comparisons look correct.
    assert compare_versions(case["right"], case["left"]) == -case["expect"]


@pytest.mark.parametrize("case", VERSION["within"], ids=ids(VERSION["within"]))
def test_version_within(case: dict[str, Any]) -> None:
    assert version_within(case["appVersion"], case["maxVersion"]) is case["expect"]


@pytest.mark.parametrize("case", VERSION["parse"], ids=ids(VERSION["parse"]))
def test_version_parse(case: dict[str, Any]) -> None:
    parsed = parse_version(case["input"])
    if case["expect"] is None:
        assert parsed is None
        return
    assert parsed is not None
    assert parsed.major == case["expect"]["major"]
    assert parsed.minor == case["expect"]["minor"]
    assert parsed.patch == case["expect"]["patch"]
    assert list(parsed.prerelease) == case["expect"]["prerelease"]


def test_the_whole_semver_example_chain_orders() -> None:
    """The chain from the specification itself.

    Every adjacent pair is one rule, and an implementation can satisfy each rule
    in isolation while composing them wrongly - so the chain is checked as a
    chain, and then sorted, which catches a comparator that is right pairwise
    but not transitive.
    """
    chain = [
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-alpha.beta",
        "1.0.0-beta",
        "1.0.0-beta.2",
        "1.0.0-beta.11",
        "1.0.0-rc.1",
        "1.0.0",
        "1.0.1",
        "1.1.0",
        "2.0.0",
    ]
    for lower, higher in zip(chain, chain[1:], strict=False):
        assert compare_versions(lower, higher) == -1, f"{lower} should order below {higher}"

    # A fixed scramble rather than a reversal: reversing is one permutation and
    # the easiest one for a broken comparator to survive. Written out rather
    # than shuffled at random so a failure is reproducible.
    scrambled = [chain[i] for i in (7, 2, 10, 0, 5, 9, 3, 1, 8, 4, 6)]
    assert sorted(scrambled) != chain, "the scramble must not already be in order"
    assert sorted(scrambled, key=cmp_to_key(compare_versions)) == chain
