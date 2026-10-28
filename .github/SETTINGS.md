# Repository settings outside git

Settings that cannot be kept in files. The owner sets them once.

| Setting | Value |
| --- | --- |
| Visibility | Public |
| Environment `release` | Required reviewer: the owner (`VectoDE`). Deployment tags: `v*` only. Set up on 2026-10-28. The npm and PyPI publish jobs run here. |
| npm Trusted Publisher | Package `@uplytech/license-client`, repository `UplyTech/LicenseClient`, workflow `release.yml`, environment `release` |
| PyPI Trusted Publisher | Project `uplytech-license-client`, repository `UplyTech/LicenseClient`, workflow `release.yml`, environment `release` |
| Repository variables | `PUBLISH_NPM` and `PUBLISH_PYPI` = `true`, each only after the Trusted Publisher above exists. Unset, a tag still produces the signed GitHub release and skips the registry. |
| npm first publish | npm configures a Trusted Publisher in the settings of an existing package. If npmjs.com offers no way to add one before the first version, the owner publishes the first version of `@uplytech/license-client` once by hand from the release tarball (`npm publish <tarball> --access public`, with 2FA) under the npm organisation `uplytech`, then adds the Trusted Publisher and sets `PUBLISH_NPM`. A new Trusted Publisher must see its first successful publish within two days, or it expires. |
| PyPI first publish | PyPI accepts a pending Trusted Publisher for a project that does not exist yet; no manual upload needed. |
| Runners | GitHub-hosted (`ubuntu-latest`): the repository is public, the organisation runner group serves private repositories only, and npm Trusted Publishing works on GitHub-hosted runners only. Minutes are free for public repositories. |
| Organisation secret | `RELEASE_SIGNING_KEY` (visibility: all repositories) |
| Branch protection on `main` | Require the `CI` check; with a single maintainer, no required approvals |
| Security | Dependabot alerts and updates, private vulnerability reporting, secret scanning with push protection |
| Code scanning | Advanced setup (`codeql.yml`); default setup stays off |
| OpenSSF Best Practices | Register on bestpractices.dev, then add the badge to the README |
