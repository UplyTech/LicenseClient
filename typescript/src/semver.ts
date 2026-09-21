/**
 * Semantic version comparison, for the one licence field nothing enforced.
 *
 * `max_version` on a licence means "usable, but not past this version" - the
 * update window a perpetual licence buys. The server stores it and puts it in
 * every status response; until this module existed the client kept it in the
 * snapshot and never looked at it, so a perpetual licence sold for the 1.x line
 * silently covered 4.0 as well.
 *
 * Why not compare the strings. `"1.10.0" < "1.9.0"` is true for a string and
 * false for a version, and the first time it matters is the tenth minor release
 * - by which point the mistake is years old and every affected customer is
 * already running a build they did not buy.
 *
 * The precedence rules here are Semantic Versioning 2.0.0, which the sibling
 * packages and the API already follow:
 *
 * - major, minor and patch compare numerically, left to right
 * - a pre-release is *lower* than the release it precedes: `2.0.0-rc.1 < 2.0.0`
 * - pre-release identifiers compare left to right; numeric ones numerically,
 *   alphanumeric ones by ASCII, and numeric sorts below alphanumeric
 * - a longer pre-release outranks the prefix it extends: `1.0.0-a < 1.0.0-a.1`
 * - build metadata after `+` is ignored entirely
 *
 * Pinned by `shared/testcases/version.json`, because two editions that order
 * versions differently would lock a customer out on one platform and not the
 * other - which is the failure mode this package exists to avoid.
 */

/** A parsed version. `prerelease` is empty for a release. */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers after `-`, already split. */
  prerelease: readonly (string | number)[];
}

/**
 * `1.2.3`, `v1.2.3`, `1.2`, `1`, with an optional `-pre` and `+build`.
 *
 * A leading `v` is accepted because half the world writes tags that way and a
 * licence that refused `v1.2.3` would be refusing the same version it allows.
 */
const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const NUMERIC = /^\d+$/;

/**
 * Parse a version, or return `null` for anything that is not one.
 *
 * `null` rather than an exception: the callers here are deciding whether to
 * lock somebody out, and every one of them treats "cannot tell" as "do not
 * lock". An exception would invite a `try` that swallows it into the wrong
 * answer.
 */
export function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const match = VERSION.exec(raw.trim());
  if (!match) return null;

  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: minor === undefined ? 0 : Number(minor),
    patch: patch === undefined ? 0 : Number(patch),
    prerelease:
      prerelease === undefined
        ? []
        : prerelease.split('.').map((part) => (NUMERIC.test(part) ? Number(part) : part)),
  };
}

/** True when the string is a version this module can order. */
export function isValidVersion(raw: string | null | undefined): boolean {
  return parseVersion(raw) !== null;
}

function comparePrerelease(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): number {
  // A release outranks any pre-release of the same numbers, so an empty list
  // is the *highest* value here - the one place this comparison inverts.
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a === b) continue;

    const aNumeric = typeof a === 'number';
    const bNumeric = typeof b === 'number';
    // "Numeric identifiers always have lower precedence than alphanumeric
    // identifiers" - so 1.0.0-1 < 1.0.0-alpha, which reads backwards until you
    // remember that alpha is a word and 1 is a build counter.
    if (aNumeric && !bNumeric) return -1;
    if (!aNumeric && bNumeric) return 1;
    if (aNumeric && bNumeric) return a < b ? -1 : 1;
    return (a as string) < (b as string) ? -1 : 1;
  }

  // Everything shared is equal: the longer list wins, because it is more
  // specific. 1.0.0-alpha < 1.0.0-alpha.1
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

/**
 * Order two versions: `-1`, `0` or `1`.
 *
 * Throws for an unparseable input, unlike {@link parseVersion}. Callers that
 * cannot afford to throw use {@link versionWithin}, which decides what an
 * unreadable version means.
 */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a) throw new TypeError(`Not a version: ${JSON.stringify(left)}`);
  if (!b) throw new TypeError(`Not a version: ${JSON.stringify(right)}`);
  return compareParsed(a, b);
}

/** {@link compareVersions} for two already-parsed versions. */
export function compareParsed(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const pre = comparePrerelease(a.prerelease, b.prerelease);
  return pre === 0 ? 0 : pre < 0 ? -1 : 1;
}

/**
 * Is this build inside the licence's update window?
 *
 * The three ways it answers `true` are all deliberate:
 *
 * - **No `maxVersion`.** A subscription has no update window; there is nothing
 *   to be past.
 * - **An unreadable `maxVersion`.** That is our data being wrong, and locking a
 *   paying customer out over a malformed field in our own database would be
 *   indefensible.
 * - **An unreadable `appVersion`.** Same direction, different reason: a build
 *   that reports `"dev"` or a commit hash is a developer's build or a
 *   distribution that rewrote the string, and neither is a licence violation.
 *
 * Failing open here is not a hole to be closed. `app_version` is sent to the
 * server on every activation and heartbeat, and the server enforces the same
 * window with data the client cannot edit. Anybody willing to patch the version
 * string in their own binary can equally patch out this call - client-side
 * checks make the honest path work offline, they do not stop the dishonest one.
 */
export function versionWithin(
  appVersion: string | null | undefined,
  maxVersion: string | null | undefined,
): boolean {
  const max = parseVersion(maxVersion);
  if (!max) return true;
  const app = parseVersion(appVersion);
  if (!app) return true;
  return compareParsed(app, max) <= 0;
}
