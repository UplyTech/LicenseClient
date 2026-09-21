/**
 * The decision: may this application run right now?
 *
 * A pure function over a cached snapshot and a clock. Everything that touches
 * the network, the disk or the operating system lives elsewhere, so this - the
 * part that can lock a paying customer out - is fully testable and pinned by
 * the shared vectors.
 */

import { versionWithin } from './semver.js';
import type { LicenseSnapshot } from './types.js';

export type LicenseState =
  | 'NOT_ACTIVATED'
  | 'ACTIVE'
  | 'LOCKED_OFFLINE'
  | 'LOCKED_EXPIRED'
  | 'LOCKED_REVOKED'
  | 'LOCKED_SUSPENDED'
  | 'LOCKED_NOT_YET_VALID'
  | 'LOCKED_WRONG_DEVICE'
  | 'LOCKED_CLOCK'
  | 'LOCKED_VERSION';

export interface Evaluation {
  state: LicenseState;
  /** Stable identifier for the reason, or null when nothing is wrong. */
  reason: string | null;
  canRun: boolean;
  /** Whether the client should contact the server, blocking or not. */
  shouldCheckIn: boolean;
  /** Whole days of offline window left. Negative once it has run out. */
  daysLeftOffline: number | null;
}

/** How far a clock may be behind the highest time ever seen. */
export const DEFAULT_CLOCK_TOLERANCE_HOURS = 24;

const HOUR = 3_600_000;
const DAY = 86_400_000;

function parse(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export interface ClockCheck {
  rolledBack: boolean;
  /** The mark to store. Never lower than the one that came in. */
  newHighWater: string;
}

/**
 * Compare the clock against the highest time this installation has ever seen.
 *
 * Winding the clock back is the cheapest way to reopen an expired offline
 * window, so the mark lives inside the encrypted cache. Beside it, in a plain
 * settings file, it would be a two-line bypass.
 *
 * The tolerance exists because honest clocks are wrong: a flat CMOS battery, a
 * laptop crossing time zones, a virtual machine resuming from a snapshot. None
 * of those should lock anybody out.
 */
export function checkClock(
  now: Date,
  clockHighWater: string | null | undefined,
  toleranceHours: number = DEFAULT_CLOCK_TOLERANCE_HOURS,
): ClockCheck {
  const nowMs = now.getTime();
  const mark = parse(clockHighWater);

  if (mark === null) {
    return { rolledBack: false, newHighWater: new Date(nowMs).toISOString() };
  }
  if (nowMs >= mark) {
    return { rolledBack: false, newHighWater: new Date(nowMs).toISOString() };
  }

  const behindMs = mark - nowMs;
  return {
    // The mark never goes down, so restarting the application does not reset it.
    rolledBack: behindMs > toleranceHours * HOUR,
    newHighWater: new Date(mark).toISOString(),
  };
}

export interface EvaluateOptions {
  /** The fingerprint of the machine this is running on, right now. */
  fingerprint?: string | null;
  clockToleranceHours?: number;
  /**
   * The version of the application asking.
   *
   * Checked against the licence's `maxVersion` - the update window a perpetual
   * licence buys. Omitting it skips that check entirely, which is what a caller
   * who does not know its own version should get: no answer rather than a wrong
   * one.
   */
  appVersion?: string | null;
}

/**
 * Decide what to do with a cached licence.
 *
 * Order matters and is not arbitrary:
 *
 *  1. no cache at all
 *  2. the cache belongs to another machine - the copy protection
 *  3. the clock was wound back - everything below reads a date
 *  4. the server's last word: revoked, suspended
 *  5. the contract: not yet started, expired, past the update window
 *  6. the connection: offline window exhausted
 *
 * Revocation before expiry, and both before the offline window, because the
 * grace period covers connection trouble and must never soften a decision the
 * server actually made.
 *
 * The update window sits with the contract rather than with the connection for
 * the same reason: "you bought the 1.x line" is something the seller decided,
 * not something a bad hotel network caused.
 */
export function evaluate(
  snapshot: LicenseSnapshot | null | undefined,
  now: Date,
  options: EvaluateOptions = {},
): Evaluation {
  if (!snapshot) {
    return {
      state: 'NOT_ACTIVATED',
      reason: 'no_license',
      canRun: false,
      shouldCheckIn: false,
      daysLeftOffline: null,
    };
  }

  const nowMs = now.getTime();
  const offlineUntil = parse(snapshot.offlineValidUntil);
  const daysLeftOffline =
    offlineUntil === null ? null : Math.floor((offlineUntil - nowMs) / DAY);

  const nextCheck = parse(snapshot.nextCheckAfter);
  const shouldCheckIn = nextCheck === null ? true : nowMs >= nextCheck;

  const locked = (state: LicenseState, reason: string): Evaluation => ({
    state,
    reason,
    canRun: false,
    // Always worth asking the server: a suspension gets lifted when the invoice
    // is paid, and the customer should not have to reinstall for that.
    shouldCheckIn: true,
    daysLeftOffline,
  });

  // The second line of the copy protection. The first is that the cache is
  // encrypted with a key derived from the fingerprint, so a file carried to
  // another machine does not decrypt at all and never reaches this function.
  // This check catches the case where a snapshot arrives some other way - and
  // it keeps standing if the cache format ever stops binding the key to the
  // machine.
  const bound = snapshot.deviceFingerprint;
  if (bound && options.fingerprint && bound !== options.fingerprint) {
    return locked('LOCKED_WRONG_DEVICE', 'fingerprint_mismatch');
  }

  if (checkClock(now, snapshot.clockHighWater, options.clockToleranceHours).rolledBack) {
    return locked('LOCKED_CLOCK', 'clock_rolled_back');
  }

  if (snapshot.status === 'revoked') return locked('LOCKED_REVOKED', 'revoked');
  if (snapshot.status === 'suspended') return locked('LOCKED_SUSPENDED', 'suspended');

  const notBefore = parse(snapshot.notBefore);
  if (notBefore !== null && nowMs < notBefore) {
    return locked('LOCKED_NOT_YET_VALID', 'not_yet_valid');
  }

  // A null expiry is a perpetual licence, not an expiry at the epoch.
  const expiresAt = parse(snapshot.expiresAt);
  if (expiresAt !== null && nowMs > expiresAt) {
    return locked('LOCKED_EXPIRED', 'expired');
  }

  if (snapshot.status === 'expired') return locked('LOCKED_EXPIRED', 'expired');

  // The update window. A perpetual licence for the 1.x line does not cover 2.0,
  // and until this check existed the client stored `maxVersion` and never read
  // it. Unreadable on either side means "do not lock" - see `versionWithin`.
  if (!versionWithin(options.appVersion, snapshot.maxVersion)) {
    return locked('LOCKED_VERSION', 'version_not_covered');
  }

  // "Valid until" - being exactly on the deadline still counts.
  if (offlineUntil !== null && nowMs > offlineUntil) {
    return locked('LOCKED_OFFLINE', 'offline_too_long');
  }

  return {
    state: 'ACTIVE',
    reason: null,
    canRun: true,
    shouldCheckIn,
    daysLeftOffline,
  };
}
