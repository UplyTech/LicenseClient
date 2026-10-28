# LicenseClient

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/UplyTech/LicenseClient/badge)](https://scorecard.dev/viewer/?uri=github.com/UplyTech/LicenseClient)

The client half of the UplyTech licensing system, in two languages with one
shared contract.

| | |
|---|---|
| `typescript/` | `@uplytech/license-client` — TeamProManager, FlashTrix, everything on Electron |
| `python/` | `uplytech-license-client` — VectoBeat and other bots, CLI tools |
| `shared/testcases/` | Test vectors both halves must satisfy |
| `shared/scripts/` | Generates the four vector files that cannot be written by hand |

The other end is `09-projects/01-internal/API`.

## What this package solves

A desktop application has to answer five questions without getting in the way
of the paying customer:

1. **Is the key they typed a key at all?** The check symbol answers that
   offline. A typo needs no network — and above all no endpoint that says "no
   such key", because that would be an oracle to guess against.
2. **Which machine is this?** A weighted fingerprint from seven components,
   each hashed on its own. Plaintext hostnames and MAC addresses never leave
   the machine.
3. **May the application run right now?** A pure function over the cached state
   and the clock. It decides whether somebody can work, so it is pinned down by
   vectors completely.
4. **Can the cache be trusted?** An Ed25519 signature from the server, plus
   AES-256-GCM with a key derived from the fingerprint. A copied file does not
   decrypt anywhere else — and the signed claims are checked against the
   snapshot beside them, because a genuine envelope for a *different* licence
   verifies just as well.
5. **Does the licence cover *this build*?** A perpetual licence buys an update
   window, and the server has always said where it ends. Comparing it as a
   version rather than as a string is the whole of the difficulty: `"1.10.0" <
   "1.9.0"` is true for a string and false for a version, and the first release
   where that matters is the tenth minor one.

## The one rule

**A network failure is not a licence failure.** If the server is unreachable
and the cached state is still inside its offline window, the application keeps
running. Anything else turns a flaky connection into a support ticket.

The reverse is just as strict: an expired or revoked licence locks immediately.
The grace period covers connection problems, not the end of a contract.

## Quick start

```ts
import { FileStorage, LicenseClient } from '@uplytech/license-client';

const licence = new LicenseClient({
  apiBaseUrl: 'https://api.uplytech.de',
  productSlug: 'teampromanager',
  appVersion: app.getVersion(),
  publicKeys: { lk_2026_01: PUBLIC_KEY },
  storage: new FileStorage(join(app.getPath('userData'), 'licence.bin')),
});

const state = await licence.ensure();
if (!state.canRun) showActivationDialog(state.reason);
if (licence.hasFeature('time_tracking')) enableTimeTracking();
```

```python
from uplytech_license import FileStorage, LicenseClient

licence = LicenseClient(
    api_base_url="https://api.uplytech.de",
    product_slug="vectobeat",
    app_version="1.4.0",
    public_keys={"lk_2026_01": PUBLIC_KEY},
    storage=FileStorage(Path.home() / ".vectobeat" / "licence.bin"),
)

licence.ensure()
if licence.has_feature("filters"):
    enable_filters()
```

The application builds the **public** key in at compile time. Were it to fetch
the key at runtime, anybody on the wire could supply their own — and issue
themselves any licence they liked.

## States

| State | Meaning |
|---|---|
| `NOT_ACTIVATED` | No cache, or it was unreadable and was discarded |
| `ACTIVE` | Running |
| `LOCKED_OFFLINE` | No contact with the server for too long |
| `LOCKED_EXPIRED` | The term is over |
| `LOCKED_REVOKED` | Revoked by the server |
| `LOCKED_SUSPENDED` | Temporarily suspended, for an unpaid invoice say |
| `LOCKED_NOT_YET_VALID` | Bought in advance, the start date has not arrived |
| `LOCKED_WRONG_DEVICE` | The cache belongs to a different machine |
| `LOCKED_CLOCK` | The system clock was set back |
| `LOCKED_VERSION` | The licence is fine; this build is past its update window |

The order of the checks is not arbitrary: revocation before expiry, both before
the offline window. Otherwise the grace period would soften a decision the
server actually made. The update window sits with the contract rather than with
the connection for the same reason — "you bought the 2.x line" is something the
seller decided, not something a bad hotel network caused.

## What the client can ask the server

| | |
|---|---|
| `activate`, `startTrial`, `heartbeat`, `deactivate` | The device's own lifecycle |
| `ensure` | The call an application makes at start-up and every few hours. Overlapping callers make one check-in. |
| `deviceStatus` | The same view, **without** the side effects. A heartbeat moves `last_seen_at` and extends the offline window, which makes it the wrong call for a diagnostics screen. |
| `listSeats`, `releaseSeat` | "My laptop died and it is still holding a seat", on the owner's token |
| `listLicenses`, `getLicense`, `revealKey` | An account screen. The revealed key is returned and never kept. |
| `verifySubject`, `verifySubjects` | Entitlement for a product that is not per-machine — a bot serving thousands of guilds from one process, asking per command |

## When the connection is bad

A licence client makes a handful of calls on whatever connection the customer
happens to have. One retry turns most hotel wifi into nothing at all, so there
is one — and the rules around it are narrow on purpose:

- **Transport failures and 5xx only.** A 401, 403 or 409 is an answer. Retrying
  an answer is how one seat-limit dialog becomes three.
- **Full jitter.** Ten thousand applications started at 09:00 on Monday must not
  retry in lockstep; without jitter the retry *is* the outage.
- **`Retry-After` wins**, up to a cap. Beyond half a minute the honest thing is
  to stop blocking and let the cache answer.
- **A budget, not just a count**, because total time is what a user experiences.
- **Nothing behind a dialog somebody is looking at**, and nothing after the
  caller aborted.

## Telling somebody what happened

This package fails quietly on purpose. A corrupt cache is discarded without a
word, because the only useful response is the activation dialog; a network
failure inside the offline window is not an error at all. That is right for the
customer in front of the screen and unanswerable for support, on the one machine
nobody can attach a debugger to.

So there is one optional callback:

```ts
const licence = new LicenseClient({
  ...,
  onEvent: (event) => log.debug(event.type, event),
});
```

Thirteen event kinds — cache discarded and *why*, request retried, signature
rejected, clock wound back, state changed. **None of them ever carries a
credential, a token, a licence key or a raw hardware value**, and anything the
listener throws is swallowed: observability is never allowed to be the thing
that stops an application starting.

## Dependencies

The sibling packages (`EconomyWorld`, `RankMode`) have zero dependencies, and
there that is a hard rule. This package departs from it **exactly once**:

- **TypeScript: none.** `node:crypto` does Ed25519, HKDF and AES-GCM.
- **Python: `cryptography>=42`.** The standard library does neither. The
  alternative — an HMAC over a secret shipped inside the application — would be
  the wrong choice for a licensing system: anybody who unpacks the package can
  then issue themselves any licence.

For HTTP the Python half uses `urllib` from the standard library. Anybody
working asynchronously passes their own `send` function or calls the methods in
a thread executor.

## Test vectors

`shared/testcases/` is the contract. Both halves read the same files.

| File | Pins down | Origin |
|---|---|---|
| `canonical-json.json` | Deterministic serialisation | generated |
| `key.json` | Key format, check symbol, normalisation | generated |
| `signature.json` | Ed25519 envelopes, genuine and tampered | generated |
| `crypto.json` | HKDF derivation and AES-GCM blobs | generated |
| `states.json` | The state machine | hand written |
| `clock.json` | Detecting a clock that was set back | hand written |
| `features.json` | Feature lookup with patterns | hand written |
| `fingerprint.json` | Weights, combination, comparison | hand written |
| `version.json` | Version ordering, and the update window | hand written |

The four generated files come from the **API's own modules**, not from this
package:

```bash
cd 09-projects/01-internal/API
./.venv/Scripts/python.exe ../../07-packages/LicenseClient/shared/scripts/generate_vectors.py
```

That direction is deliberate. The server decides what a key looks like and what
gets signed; the client follows. Were the package to generate the vectors from
itself, it would only prove that it agrees with itself.

The four hand-written files are the **specification**. They are not generated,
because then nobody could say any more whether the described behaviour is
intended or merely what happens to be implemented.

**Never regenerate a vector to make a test pass.** If a vector changes, the
format changed — and clients already installed stop working. That belongs in
the changelog and in a new version.

## Development

```bash
cd typescript && npm install && npm test && npm run lint && npm run build
cd python    && pip install -e ".[dev]" && pytest && ruff check . && mypy

# Both editions at once
node .github/scripts/check-versions.mjs   # one version number everywhere
node .github/scripts/check-vectors.mjs    # no vector that nothing reads
node .github/scripts/check-surface.mjs    # the same 85 names on both sides
```

| | TypeScript | Python |
|---|---|---|
| Tests | 322 | 363 |
| Statement coverage | 99.8 % (floor 99) | 99.9 % (floor 99) |
| Mandatory dependencies | 0 | 1 (`cryptography`, and the reason is above) |

The shared vectors prove the two editions agree about what they **compute**.
`check-surface.mjs` is the other half: that they agree about what they
**offer**. A method that exists in TypeScript and not in Python is a support
ticket six months later, in whichever language nobody is looking at.

## Install

```bash
npm install @uplytech/license-client   # TypeScript
pip install uplytech-license-client  # Python
```

> **Not on npm or PyPI yet.** The first release is pending the Trusted Publisher setup on both registries. Until then, build from a clone (see [Development](#development)) or use the signed artefacts of a [GitHub release](https://github.com/UplyTech/LicenseClient/releases) once one exists.

## Security and OpenSSF

- **CI** runs on GitHub-hosted runners (`ci.yml`, `quality.yml`, `docs.yml`, `security.yml`, `nightly.yml`). The repository is public and the organisation runner serves private repositories only; for public repositories the hosted minutes are free. Pull requests are validated with a read-only token and without secrets; no workflow uses `pull_request_target`. Every action is pinned to a full commit SHA.
- **OpenSSF Scorecard** runs weekly and on every push to `main` (`scorecard.yml`) and publishes its result; the badge at the top shows the current score.
- **CodeQL** (`codeql.yml`) and **dependency review** on pull requests (`dependency-review.yml`) run on every change.
- **OpenSSF Best Practices badge** (bestpractices.dev): pending owner registration.
- **Supply chain**: Dependabot for npm, pip, Docker and GitHub Actions (weekly, minor and patch grouped), gitleaks and OSV scans on a schedule, [SECURITY.md](./SECURITY.md) with private reporting.
- **Not achievable here**: with a single maintainer the Scorecard checks for code review and contributors stay low.

### Releases and how to verify them

A release is created from a `v*` tag by `release.yml`: tests, build, signature, the GitHub release, then the registries. The registry jobs run in the environment `release`, which accepts only `v*` tags and waits for the owner's approval, and use Trusted Publishing (OIDC), so no long-lived registry token exists. Each registry is switched on separately with the repository variables `PUBLISH_NPM` and `PUBLISH_PYPI` once its Trusted Publisher is configured ([.github/SETTINGS.md](./.github/SETTINGS.md)); without them a tag still produces the signed GitHub release. Only a tag on a commit that is on `main` is released.

- **npm**: `@uplytech/license-client`, published with `npm publish --provenance`. Check with `npm audit signatures` or on the package page ("Built and signed on GitHub Actions").
- **PyPI**: `uplytech-license-client`, published with `pypa/gh-action-pypi-publish` (PEP 740 attestations included).
- **GitHub release**: the same artefacts (npm tarball, wheel, sdist), `SHA256SUMS`, an in-toto SLSA provenance statement (`provenance.intoto.json`) and one UplyTech signature per file (`<file>.sig`, base64 of an ECDSA P-256 / SHA-256 signature).

```bash
# 1. UplyTech signature (public key: release-signing.pub in this repository)
base64 -d <file>.sig > <file>.sig.der
openssl dgst -sha256 -verify release-signing.pub -signature <file>.sig.der <file>
sha256sum -c SHA256SUMS --ignore-missing

# 2. GitHub build attestation
gh attestation verify <file> --repo UplyTech/LicenseClient
```

The signing key is the organisation secret `RELEASE_SIGNING_KEY`; the release job fails when it is empty instead of publishing unsigned files.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Copyright (c) 2021-present UplyTech. UplyTech has existed as a community since 2021.
