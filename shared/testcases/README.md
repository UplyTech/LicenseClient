# Shared test vectors

These files are the contract between the Python and the TypeScript edition of
the licence client — and between both of them and the API.

Two halves that quietly behave differently are worse than two separate
implementations, because nobody expects the difference. In a licensing system
the difference means, in the worst case: a paying customer cannot work on one
platform, while on the other a revoked licence keeps running.

## Two kinds of file

**Generated** — cryptographic output nobody can write from memory. A
hand-typed hash that happens to be wrong would make both halves agree on the
same wrong answer.

| File | Pins down |
|---|---|
| `canonical-json.json` | Deterministic serialisation: sorted keys, no whitespace, raw UTF-8 |
| `key.json` | Key alphabet, check symbol, normalisation, rejected inputs |
| `signature.json` | Ed25519 envelopes — one genuine, six broken in different ways |
| `crypto.json` | HKDF derivation and the cache's AES-256-GCM blobs |

**Hand written** — the specification, not the output. Generating them would
only prove that an implementation agrees with itself.

| File | Pins down |
|---|---|
| `states.json` | The state machine: may the application run? |
| `clock.json` | Detecting a system clock that was set back |
| `features.json` | Feature lookup, including the patterns |
| `fingerprint.json` | Weights, combination, weighted comparison |

## Generating

The authority is the **API**, not this package:

```bash
cd Projekte/Intern/API
./.venv/Scripts/python.exe ../../Packages/LicenseClient/shared/scripts/generate_vectors.py
```

That direction is deliberate. The server decides what a key looks like and what
gets signed; the client follows.

## Who reads them

| | |
|---|---|
| TypeScript | `typescript/tests/shared-vectors.test.ts` |
| Python | `python/tests/test_shared_vectors.py` |

## Field naming

Every field uses the JSON spelling (camelCase) — `offlineValidUntil`,
`clockHighWater`, `expectKeyBase64` — in both editions. The Python side maps
them onto its own snake_case interface when it loads a vector. One spelling in
the files keeps the diffs readable.

## The rule

**Never regenerate a vector to make a test pass.**

If a vector changes, the format changed. Clients already shipped then stop
working — they verify signatures against the old serialisation and decrypt
caches with the old derivation. That belongs in the changelog and in a new
major version, not in a quiet commit.

When a test fails, the first question is always: *did the behaviour change, and
was that intended?*
