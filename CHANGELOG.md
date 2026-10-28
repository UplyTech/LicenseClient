# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the versioning [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For this package that means something concrete: **every change to a file in
`shared/testcases/` is a change to the wire format.** Clients already shipped
verify signatures against the old serialisation and decrypt their cache with
the old derivation. A change like that is a new major version and needs a
migration path, not a changelog bullet.

## [Unreleased]

### Changed

- **Node 22.12 or newer** (`engines.node` was `>=20.0.0`). Node 20 is end-of-life, and CI tests on Node 22 and 24 only.
- **Licence: Apache License 2.0** (was MIT). `LICENSE` carries the full Apache text, `NOTICE` the attribution `Copyright (c) 2021-present UplyTech` (UplyTech has existed as a community since 2021); both ship in the npm package, the wheel and the sdist. Author fields name UplyTech only.
- Registry names: `@uplytech/license-client` on npm, `uplytech-license-client` on PyPI.
- Releases publish to npm and PyPI with Trusted Publishing (OIDC, no registry token) and npm provenance, after the signed GitHub release. Each registry is switched on with a repository variable once its Trusted Publisher exists. Every artefact also gets a GitHub build attestation.
- CI runs on GitHub-hosted runners, since the repository is public and the organisation runner serves private repositories only. Pull requests are validated again (read-only token, no secrets); CodeQL, dependency review and a published OpenSSF Scorecard are part of the checks.
- Repository links point to `github.com/UplyTech/LicenseClient`.
- `NOTICE` names the licensor in full: UplyTech, Tim Hauke, Albert-Schweitzer-Ring 42, 25524 Itzehoe, Germany. Python metadata uses the PEP 639 fields (`license = "Apache-2.0"`, `license-files`); the wheel carries `LICENSE` and `NOTICE` under `licenses/`.
- Test toolchain: Vitest 5, ESLint 9 with a flat config, typescript-eslint 8. This clears the advisories in the old Vitest/Vite/esbuild dev tree (none of it reached a caller). The test matrix runs Node 22 and 24; Node 20 is end-of-life and Vitest 5 needs 22.12 or newer.
- Releases start only from a pushed `v*` tag on `main`; the manual trigger is gone. The registry jobs run in the environment `release` (only `v*` tags, the owner approves). Tool images in CI are pinned by digest. The Python dependency audit runs against the pinned dev environment and fails on any finding.

## [2.0.0] — 2026-09-09

The client now enforces the field it was already storing, covers the endpoints
the server was already offering, and says out loud what it has been doing
silently.

**Why a major version.** `Sender` in the Python edition gained a third element,
`LOCKED_VERSION` is a state an exhaustive `switch` did not have, and a perpetual
licence past its update window now locks where it previously ran. None of those
breaks a caller that does the obvious thing, and all three change behaviour
somebody could be relying on.

### Fixed

- **`max_version` was stored and never read.** The server has always sent the
  update window a perpetual licence buys — "usable, but not past this version" —
  and the client kept it in the snapshot and looked at it exactly never. A
  licence sold for the 1.x line silently covered 4.0.

  There is now a `LOCKED_VERSION` state, and a semantic-version comparator
  behind it, because the obvious implementation is wrong in a way that only
  shows up years later: `"1.10.0" < "1.9.0"` is true for a string and false for
  a version, and the first release where it matters is the tenth minor one.
  48 cases in `shared/testcases/version.json` pin the ordering in both editions,
  including the whole precedence chain from the SemVer specification and the
  rule that reads backwards — a numeric pre-release identifier sorts *below* an
  alphanumeric one, so `1.0.0-1 < 1.0.0-alpha`.

  Where it cannot tell, it does not lock: an unreadable `max_version` is our
  own data being wrong, and an unreadable `app_version` is a developer build or
  a repackaged distribution. The server enforces the same window on data the
  client cannot edit.

- **The clock mark only moved on a heartbeat.** An application started offline
  on Monday and closed on Friday left a mark from Monday, and Friday's user
  could wind the clock back four days to reopen an expired offline window. The
  mark now advances on every `load()` — forwards only, so it can never shorten
  a window either.

- **`verifyCachedSignature` verified the maths and not the binding.** A genuine
  envelope for a different product, for a different machine, or naming a
  different licence than the snapshot beside it all verified perfectly. All
  three mean the cache has been assembled from parts, and all three are now
  refused.

- **A seat limit named the machines holding a seat and offered no way to free
  one.** `SeatLimitError.active_seats` has always carried the list; there was no
  method behind it. There is now.

### Added — the endpoints the server already had

| | |
|---|---|
| `deviceStatus()` | Read the server's view *without* the side effects of a heartbeat. A "check now" button that quietly extended the offline window it was reporting on was worse than no button. |
| `listSeats()`, `releaseSeat()` | The "my laptop died and it is still holding a seat" path, on the owner's token rather than the device's. |
| `listLicenses()`, `getLicense()`, `revealKey()` | An account screen. The revealed key is returned and never cached, never sealed into the file, never put into an event. |
| `verifySubject()`, `verifySubjects()` | Entitlement for a product that is not per-machine — a Discord bot serving thousands of guilds from one process, asking per command. Answers 200 for an unlicensed subject too, with the free tier, so a freemium product has one code path. The bulk form refuses more than the hundred the server accepts rather than sending them and reading the 422 back. |
| `subject` on `activate()` and `startTrial()` | A licence that belongs to a guild rather than to a computer. |

### Added — behaviour

- **Retrying, narrowly.** Transport failures and 5xx only; a 401, 403 or 409 is
  an answer, and retrying an answer is how one seat-limit dialog becomes three.
  Exponential backoff with **full jitter**, because ten thousand desktop
  applications started at 09:00 on Monday must not retry in lockstep. A
  `Retry-After` from the server wins over the computed delay, up to a cap —
  beyond half a minute the honest thing is to stop blocking and let the cache
  answer. A total budget as well as an attempt count, because total time is
  what a user experiences. Nothing is retried behind an activation dialog
  somebody is looking at, and nothing is retried after the caller aborted.
- **`RateLimitError`**, carrying `retryAfterMs`, so an application can schedule
  rather than poll.
- **One check-in from overlapping callers.** Three windows of an Electron
  application at start-up were three round trips, three nonces and three cache
  writes racing to be last. The asynchronous edition shares one promise; the
  threaded one records when a check-in finished and lets a caller that was
  waiting use it.
- **An optional `onEvent` listener.** This package fails quietly on purpose — a
  corrupt cache is discarded without a word, because the only useful response is
  the activation dialog. That is right for the customer and unanswerable for
  support, on the one machine nobody can attach a debugger to. Thirteen event
  kinds, none of which ever carries a credential, a token or a licence key, and
  anything the listener throws is swallowed: observability is never allowed to
  be the thing that stops an application starting.
- **`FeatureIndex`.** The same matching rules, prepared once. `hasFeature` is
  asked from menu-enable code and render paths, hundreds of times a second, with
  the same answer every time; the linear scan is nothing at ten entries and
  measurable at a few hundred.
- **A memoised evaluation.** Keyed on the snapshot's identity *and* the current
  second, so repeated reads are free and a licence that expires still expires on
  time.
- **`daysUntilExpiry`, `warnings`, `versionCovered`, `grantedFeatures()`.** What
  a renewal banner needs, without every product rounding the days itself and
  disagreeing with the lock by one.
- **`ValidationError`**, for the one limit this client refuses before sending.

### Changed

- **`Sender` (Python) returns `(status, text, headers)`.** `Retry-After` lives in
  the headers, and a sender that dropped them would turn a polite backoff into a
  hammering one. **The two-element shape still works** — it is what the bots
  wrapping this in an executor were written against, and breaking them to add a
  feature they did not ask for would be the wrong trade for a package whose job
  is not interrupting somebody's application.
- Activation and trial no longer retry. A person is watching that dialog, and a
  clear message beats four seconds of a spinner.
- `SeatCounts` is a named type in TypeScript too. It was spelled inline in three
  places, so a caller rendering "3 of 5 in use" had nothing to annotate with.

### Added — checks

- **`.github/scripts/check-surface.mjs`.** The shared vectors prove the editions
  agree about what they *compute*; nothing proved they agree about what they
  *offer*. 16 areas, 85 names, both editions — and it found two gaps on its
  first run. A name that is deliberately one-sided has to be listed with the
  reason; there is one.
- **`shared/testcases/version.json`**, and eight update-window cases in
  `states.json`.
- The vector harnesses now **refuse a field the snapshot does not have** instead
  of ignoring it. That is not hypothetical: the first update-window vectors
  "passed" against an evaluator that never saw a `maxVersion`, because the
  Python harness mapped fields through a hand-maintained whitelist and dropped
  the rest in silence.
- A spelling vocabulary in `.github/cspell-vocabulary.txt`, grouped and
  explained, so the gate signals a real typo rather than 118 base32 fixtures.

### Coverage

| | TypeScript | Python |
|---|---|---|
| Tests | 322 | 363 |
| Statements | 99.8 % | 99.9 % |
| Branches | 95.0 % | 99.6 % |
| Functions | 100 % | 100 % |

The floors moved with them, from 95/90 to 99/94 and from 95 to 99. What is left
uncovered is marked in the source with the reason it cannot run — the fallback
to the real hardware probe, and two `except` clauses that need the private
signing key or a change of mind from `cryptography`.

## [1.0.0] — 2026-09-05

First release. TypeScript and Python, one shared contract.

### Included

- **Key format** — Crockford Base32 without I, L, O, U; 15 symbols, 75 bits;
  a Luhn mod 32 check symbol that catches a typo offline. Confusable characters
  are folded (`I`→`1`, `L`→`1`, `O`→`0`, `U`→`V`); the brand prefix `ULT` is
  stripped rather than folded.
- **Fingerprint** — seven components with weights (summing to 12), each hashed
  on the machine itself. `install_id` deliberately does not feed into the
  combined fingerprint, so that a reinstall does not cost the seat. Windows,
  macOS and Linux are queried separately; every source is allowed to fail.
- **Activation, heartbeat, deactivation, trial** — including a single retry of
  the device token on a 401.
- **Ed25519 verification** — over the base64url-**decoded** payload bytes. The
  nonce (against replay), the fingerprint (against a response intercepted on
  another machine) and the product are checked as well.
- **Encrypted cache** — AES-256-GCM, key derived from the fingerprint via
  HKDF-SHA256. A copied file does not decrypt anywhere else. A damaged cache is
  discarded, never fatal.
- **State machine** — nine states, a pure function, pinned down by vectors.
  Revocation before expiry, both before the offline window.
- **Clock check** — a high-water mark *inside* the encrypted blob, with 24
  hours of tolerance for honest mistakes.
- **Feature lookup** with prefix patterns.
- **Base URL normalisation** that accepts `/v1`, `/api/v1` and trailing slashes
  alike — so that settings stored by older versions keep working.

### Deliberate decisions

- **Ed25519 rather than HMAC.** `FlashTrix/docs/OFFLINE.md` describes an HMAC.
  For local file integrity that is right; as a server signature it is unusable:
  the client would have to know the secret, and could then issue itself any
  licence.
- **Floating point is forbidden in the canonical JSON.** Python writes `1.0`,
  JavaScript writes `1`. Licence payloads contain none anyway, and failing
  loudly beats a signature that quietly stops matching.
- **Python gets `cryptography>=42`** — the only departure from the sibling
  packages' zero-dependency rule, with the reasoning in `README.md`.
- **A network failure is not a licence failure.** `ensure()` swallows a failed
  connection and a 5xx for as long as the cache still permits running. A 4xx
  refusal from the server is passed through.
