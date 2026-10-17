# Contributing

## Layout

```text
shared/testcases/   the contract - both halves satisfy the same files
shared/scripts/     generates the four files that cannot be written by hand
typescript/         @uplytech/license-client
python/             uplytech-license-client
```

The other end is `09-projects/01-internal/API`. It decides the wire format; this
package follows.

## Setting up

```bash
cd typescript && npm install
cd ../python  && python -m venv .venv && ./.venv/Scripts/python.exe -m pip install -e ".[dev]"
```

## Before every commit

```bash
cd typescript && npm run lint && npm run typecheck && npm test
cd ../python  && ruff check . && mypy && pytest

# Both editions at once. Needs python and node on PATH.
node .github/scripts/check-versions.mjs
node .github/scripts/check-vectors.mjs
node .github/scripts/check-surface.mjs
node .github/scripts/check-docs.mjs
```

The coverage gates are 99 % of statements in both editions. That is not
decoration: the part that decides whether an application may start has no
visible symptoms when it is wrong — it simply locks out the wrong person. What
is left uncovered is marked in the source with the reason it cannot run, never
with a bare pragma. Three such lines exist, and each names the runtime
behaviour that makes it unreachable.

### The two sweeps

`check-surface.mjs` is the half the vectors do not cover. They prove the two
editions agree about what they **compute**; this proves they agree about what
they **offer**. 16 areas, 85 names. A name that exists on one side only has to
be listed in `EDITION_ONLY` with the reason — there is one, and a growing list
would mean the file had become a place to record drift rather than to catch it.

`check-vectors.mjs` refuses a file in `shared/testcases/` that no suite reads.
A vector nobody loads is worse than no vector: it looks like coverage.

## A change that touches both halves

Almost every change does. The order is:

1. **The API first**, if the wire format changes.
2. **Regenerate the vectors**, if one of the four generated files is affected:

   ```bash
   cd 09-projects/01-internal/API
   ./.venv/Scripts/python.exe ../../07-packages/LicenseClient/shared/scripts/generate_vectors.py
   ```

3. **Add hand-written vectors**, if the *behaviour* changes. The vector comes
   before the implementation — otherwise it only describes, after the fact,
   whatever happened to come out.

   Both harnesses **refuse a vector field the snapshot does not have**, loudly.
   That is not a nicety: the first update-window vectors passed against an
   evaluator that never saw a `maxVersion`, because the Python harness mapped
   fields through a hand-maintained whitelist and dropped the rest in silence.
   A green test for a value that never reached the code is the worst kind.
4. **Change both halves.** Never only one. A half that can do something the
   other cannot is a bug that first shows up at a customer.
5. **Changelog**, with the *why*.

## What is deliberately different here from the sibling packages

`EconomyWorld` and `RankMode` have zero dependencies, and there that is a hard
rule. This package departs from it exactly once: the Python half needs
`cryptography>=42`, because the standard library does neither Ed25519 nor
AES-GCM. The reasoning is in the README and belongs there — an exception
without a written reason becomes a habit next time.

## What must never happen

**Changing a vector to make a test pass.** The vectors describe what already
installed clients expect. If one changes, those clients stop working — they
verify signatures against the old serialisation and decrypt their cache with
the old derivation.

When a test fails, the first question is: *did the behaviour change, and was
that intended?* If the answer is yes, it is a new major version with a
migration path.

**Building a secret into the client.** The client gets the public key, never
the private one and never a shared HMAC key. Otherwise anybody who unpacks an
Electron bundle can issue themselves any licence.

**Treating a network failure as a refusal.** If the server is unreachable and
the cache is still valid, the application keeps running. Anything else turns a
flaky connection into a support ticket.

**Retrying something that was a decision.** A 401, 403 or 409 is an answer, not
a hiccup. Retrying one is how a single seat-limit dialog becomes three, and how
a rate limit that would have lifted gets tightened instead.

**Locking somebody out over a field we cannot read.** An unreadable
`max_version` is our own data being wrong; an unreadable `app_version` is a
developer build. Both fail *open*, and the server enforces the same rules on
data the client cannot edit. A client-side check makes the honest path work
offline; it is not what stops the dishonest one.

**Adding a name to one edition only.** `check-surface.mjs` fails, on purpose. A
method that exists in TypeScript and not in Python is a support ticket six
months later, in whichever language nobody is looking at.
