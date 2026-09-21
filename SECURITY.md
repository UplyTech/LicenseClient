# Security

## What this package protects — and what it does not

A licensing system on the user's own machine is a **hurdle, not a safe**.
Anybody who takes the application apart can cut the check out. That is not a
shortcoming of this implementation, it is the situation: code running on
somebody else's hardware belongs to that hardware.

What is actually prevented:

| | |
|---|---|
| Passing a key on | Seats are counted server-side |
| Copying a licence file | The fingerprint is inside the signed payload, and the file does not decrypt anywhere else |
| Issuing yourself a licence | Ed25519 — the client only has the public key |
| Replaying an old response | A nonce inside the signed payload |
| Setting the clock back | A high-water mark *inside* the encrypted cache, advanced on every start |
| Running offline forever | `offline_valid_until`, set by the server |
| Upgrading past what was bought | `max_version`, compared as a version and not as a string |
| Assembling a cache from parts | The signed claims are checked against the snapshot beside them |

What is **not** prevented: a patched binary. No client-side technique helps
against that, and trying costs more than it returns.

## Principles

**The client never holds a secret that a licence can be made from.** No private
key, no shared HMAC key. The public signing key is built in, not fetched at
runtime — otherwise anybody on the wire could supply their own.

**Nothing identifying leaves the machine.** Every fingerprint component is
hashed locally with SHA-256. Hostnames, MAC addresses and user names are
personal data; the server has no reason to hold them, and does not.

**The cache is bound to the machine.** AES-256-GCM with a key derived from the
fingerprint via HKDF. There is no key file lying next to it that could be
copied along.

**A damaged cache is never fatal.** It is discarded, and the application
behaves as it did before the first activation. A power cut must not end in a
reinstall.

**Error messages give nothing away.** A key with a typo is recognised *offline*
by its check symbol, without a request. There is no endpoint that says "no such
key" — it would be an oracle to guess against.

**The event listener is not a back door.** `onEvent` exists so a support
engineer can find out why a cache was discarded on a machine they cannot reach.
Nothing it receives carries a credential, a token, a licence key or a raw
hardware value — fingerprints appear only in the already-hashed form. A revealed
licence key is returned to the caller and never passes through it.

**A clock mark that only moves forward.** It advances whenever the client sees a
later time, not only on a heartbeat. Without that, an application started
offline on Monday and closed on Friday leaves a Monday mark, and Friday's user
can wind the clock back four days to reopen an expired offline window.

**A signature is not on its own evidence.** `verifyCachedSignature` checks that
the claims name *this* product, *this* machine and *this* licence. A genuine
envelope for a different one of any of those verifies perfectly and still means
the cache has been assembled from parts.

## Reporting a vulnerability

To **<security@uplytech.de>**, not as a public ticket. Useful: the affected
edition and version, a minimal path to reproduce it, and your assessment of
what it achieves.

A reply within three working days. A vulnerability that allows issuing valid
licences, or bypassing the seat count, is handled first.

## Test material

`shared/testcases/signature.json` contains an Ed25519 key pair, and
`shared/scripts/generate_vectors.py` the matching private key. That is **test
material**: it lives in a repository, which by definition makes it not a secret
any more. It must never be used in production.

Real key material is created with

```bash
uplytech signing generate-keypair
uplytech signing generate-encryption-key
```

and lives in the server's environment — never in the database, never in the
repository.
