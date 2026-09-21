/** The shapes that travel between this library, the server and the caller. */

import type { LicenseEventListener } from './events.js';
import type { SeatCounts, SeatLimitDetail, SeatSummary } from './errors.js';
import type { RetryPolicy } from './retry.js';
import type { SignedEnvelope } from './signature.js';

export type {
  LicenseEventListener,
  RetryPolicy,
  SeatCounts,
  SeatLimitDetail,
  SeatSummary,
  SignedEnvelope,
};

/**
 * What a licence is granted to, when it is not granted to a machine.
 *
 * A Discord bot's licence belongs to a guild, not to the computer the bot runs
 * on - one process serves thousands of guilds, and binding it to a seat would
 * be meaningless. The server takes the same shape for both.
 */
export interface SubjectRef {
  type: string;
  ref: string;
}

/** One machine holding a seat, as the owner-facing endpoints report it. */
export interface Seat {
  id: number;
  device_name: string;
  platform: string;
  app_version: string;
  status: string;
  last_seen_at: string;
  activated_at: string;
}

/** The answer to "is this subject entitled?". Always given, licence or not. */
export interface EntitlementResult {
  licensed: boolean;
  /** The free tier's name when `licensed` is false, so a caller can still branch. */
  tier: string;
  features: string[];
  licenseId: string | null;
  expiresAt: string | null;
  subject: SubjectRef;
}

/** A licence as its owner sees it in an account screen. */
export interface OwnedLicense {
  public_id: string;
  product_id: number;
  product_name: string | null;
  product_slug: string | null;
  subject_type: string;
  subject_ref: string;
  type: LicenseType;
  status: LicenseStatus;
  tier: string;
  seat_model: string;
  seat_limit: number;
  seats_used: number;
  /** The first characters of the key, for recognising it. Never the whole key. */
  key_prefix: string;
  key_last4: string;
  starts_at: string;
  expires_at: string | null;
  max_version: string | null;
  created_at: string;
}

export interface OwnedLicenseList {
  items: OwnedLicense[];
  total: number;
  page: number;
  page_size: number;
}

export type LicenseStatus =
  | 'pending'
  | 'active'
  | 'trialing'
  | 'suspended'
  | 'expired'
  | 'revoked';

export type LicenseType = 'subscription' | 'perpetual' | 'trial' | 'free';

/**
 * What the client keeps between runs.
 *
 * Field names are camelCase here and snake_case on the wire; the transport
 * translates once, so nothing above it has to remember which spelling it is
 * holding.
 */
export interface LicenseSnapshot {
  licenseId: string;
  product: string;
  type: LicenseType;
  status: LicenseStatus;
  tier: string;
  features: string[];
  seatId: number | null;
  /** The machine this licence is bound to. Null for a seatless licence. */
  deviceFingerprint: string | null;
  notBefore: string | null;
  expiresAt: string | null;
  offlineValidUntil: string | null;
  nextCheckAfter: string | null;
  gracePeriodDays: number;
  maxVersion: string | null;
  lastCheckAt: string;
  /** Highest time this installation has ever seen. Inside the sealed cache. */
  clockHighWater: string;
  seats: SeatCounts | null;
  warnings: string[];
}

/** What the cache file holds, once opened. */
export interface CachedLicense {
  version: 1;
  snapshot: LicenseSnapshot;
  deviceAccessToken: string;
  deviceRefreshToken: string;
  /** The envelope as it arrived, so the signature can be re-checked at any time. */
  signedLicense: SignedEnvelope | null;
  apiBaseUrl: string;
}

/** What the activation and heartbeat endpoints answer. */
export interface ActivationResponse {
  device_access_token: string;
  device_refresh_token: string;
  expires_in: number;
  seat_id: number | null;
  license: LicenseStatusResponse;
  signed_license: SignedEnvelope | null;
  warnings: string[];
}

export interface LicenseStatusResponse {
  license_id: string;
  product: string;
  type: LicenseType;
  status: LicenseStatus;
  tier: string;
  features: string[];
  expires_at: string | null;
  seats: SeatCounts | null;
  seat_id: number | null;
  grace_period_days: number;
  offline_valid_until: string | null;
  next_check_after: string | null;
  max_version: string | null;
  warnings: string[];
}

/** Somewhere to keep the sealed cache. Bring your own for tests or Electron. */
export interface Storage {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

export interface LicenseClientOptions {
  /** Where the API lives. Trailing slashes and a trailing /api/v1 are tolerated. */
  apiBaseUrl: string;
  productSlug: string;
  appVersion: string;
  /** `key_id -> base64url public key`, compiled into the application. */
  publicKeys: Readonly<Record<string, string>>;
  storage: Storage;
  /**
   * Identifies this installation. Generated once, stored by the caller, and
   * the one fingerprint component this library cannot derive on its own.
   */
  installId?: string;
  /** Overrides the machine probe. For tests and for Electron's main process. */
  device?: {
    fingerprint: string;
    components: Record<string, string>;
    name?: string;
    platform?: string;
    osVersion?: string;
    vmSuspected?: boolean;
  };
  requestTimeoutMs?: number;
  clockToleranceHours?: number;
  /**
   * When to try a failed request again. Defaults to two retries with jitter.
   *
   * Pass `NO_RETRY` for a caller that does its own scheduling, or a stricter
   * policy for a call behind a dialog somebody is looking at.
   */
  retry?: RetryPolicy;
  /**
   * Told what the client just did: cache discarded, request retried, signature
   * rejected. Optional, never required, and anything it throws is swallowed.
   *
   * Nothing it receives ever contains a credential, a token or a licence key.
   */
  onEvent?: LicenseEventListener;
  /**
   * What this licence is granted to, for a product that is not per-machine.
   *
   * A Discord bot's licence belongs to a guild. Passing it here sends it with
   * the activation, where the server binds the licence to the subject instead
   * of consuming a seat.
   */
  subject?: SubjectRef;
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}
