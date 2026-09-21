# Repository settings the workflows assume

Everything in `.github/` is committed, so it can be reviewed. Four things cannot
be - they live in the repository's settings, and a workflow that assumes them
fails at the least helpful moment if they are missing. This is that list.

## 1. Branch protection on `main`

| Setting | Value | Why |
|---|---|---|
| Require a pull request | on, 1 approval | `CODEOWNERS` does the rest |
| Require review from Code Owners | on | the critical paths are release decisions |
| Require status checks | **`CI`** | one name, deliberately |
| Require branches up to date | on | a merge never tested against `main` is untested |
| Require conversation resolution | on | |
| Allow force pushes / deletions | off | |

Point the required status check at the job literally called **`CI`** - the
summary job at the bottom of `ci.yml`. Every matrix combination cannot be listed
by hand without the list going stale the first time the matrix changes.

## 2. Publishing environments

### `pypi`

Create the environment, restrict it to `main` and to tags, then set up
**trusted publishing** on PyPI:

| Field | Value |
|---|---|
| Owner | `uplytech` |
| Repository | `licenseclient` |
| Workflow | `release.yml` |
| Environment | `pypi` |

No API token, no secret.

### `npm`

Same restrictions, one secret:

| Secret | What |
|---|---|
| `NPM_TOKEN` | A **granular** access token, scoped to `@uplytech/license-client`, read and write, no other package |

The package is scoped, so `npm publish` needs `--access public` on the first
release or it publishes privately. `release.yml` passes it every time.

## 3. Repository features

| Setting | Value | Why |
|---|---|---|
| Discussions | on | `ISSUE_TEMPLATE/config.yml` sends "how do I ...?" there |
| Wiki, Projects | off | the documentation is in the repository |
| Default workflow permissions | **read** | every workflow declares what it needs; `security.yml` checks that they all do |
| Allow Actions to create and approve pull requests | on | Dependabot auto-merge |
| Dependency graph, Dependabot alerts and security updates | on | |
| Secret scanning + push protection | on | gitleaks covers the history, this covers the next push |
| Private vulnerability reporting | on | a second door next to <security@uplytech.de> |
| Auto-merge | on | `dependabot-auto-merge.yml` needs it |
| Squash merging only | on | the release notes are built from merged titles |

## 4. Teams

`CODEOWNERS` refers to two teams:

| Team | Owns |
|---|---|
| `@uplytech/packages` | both editions, the tests, day-to-day review |
| `@uplytech/owners` | `.github/`, the critical paths, CONTRIBUTING, SECURITY, CHANGELOG |

## First run, in order

1. Create the two teams.
2. Turn on the repository features in section 3.
3. Push `main`. `labels.yml` creates the labels on the first push that touches
   it - or run it by hand from the Actions tab.
4. Let CI go green once, then add the branch protection rule in section 1.
5. Set up the two environments in section 2 **before** the first tag, not after.
