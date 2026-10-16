# Repository settings the workflows assume

Everything in `.github/` is committed, so it can be reviewed. These things live in
the repository or organisation settings instead; the owner sets them.

## Runner and triggers

All workflows run on the organisation runner (`runs-on: [self-hosted, server-main]`): ephemeral, one job at a time, root-equivalent through the Docker socket. For that reason **no workflow has a `pull_request` or `pull_request_target` trigger**: code from a branch, Dependabot branches included, must not run there before a human has merged it. CI runs on `main` after the merge.

## 1. Branch protection on `main` (owner side)

| Setting | Value |
|---|---|
| Require a pull request, 1 approval | on (a single maintainer cannot satisfy it on his own commits; leave off or use a bypass) |
| Require status checks | `CI` (the summary job at the bottom of `ci.yml`) |
| Allow force pushes / deletions | off |

## 2. Releases

`release.yml` runs on `v*` tags. It needs one organisation secret:

| Secret | What |
|---|---|
| `RELEASE_SIGNING_KEY` | PEM private key (ECDSA P-256) matching `release-signing.pub` in the repository root |

The job fails with a clear message when the secret is empty. **Nothing is published to npm or PyPI**; the artefacts, `SHA256SUMS`, `provenance.intoto.json` and the `.sig` files go to the GitHub release only. Publishing to a registry would need a separate, explicit decision.

## 3. Repository features

| Setting | Value |
|---|---|
| Default workflow permissions | **read** (every workflow also declares its own `permissions:`) |
| Dependency graph, Dependabot alerts and security updates | on |
| Secret scanning + push protection | on |
| Private vulnerability reporting | on |

## 4. OpenSSF Best Practices badge

Registration at bestpractices.dev needs the owner's login: pending owner registration.
