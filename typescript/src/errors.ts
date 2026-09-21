/**
 * One error class per thing that can go wrong, because the caller reacts
 * differently to each.
 *
 * A malformed key is a message next to the input field. A seat limit is a
 * dialog offering to free one. A network failure while a valid cache is still
 * inside its offline window is not an error at all - the application keeps
 * running and tries again later. Collapsing these into one Error type is what
 * makes licence dialogs unhelpful.
 */

export class LicenseError extends Error {
  /** Stable identifier, safe to switch on and to look up in a message table. */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    // Extending a builtin needs this to keep instanceof working when the
    // package is consumed as compiled ES5 by an older bundler.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The caller asked for something this library will not send.
 *
 * Raised before any request, and only for a limit the server also enforces -
 * so the difference between this and the 422 it prevents is a round trip and a
 * clearer message, never a different rule.
 */
export class ValidationError extends LicenseError {
  constructor(message: string) {
    super(message, 'validation');
  }
}

/** The typed key is not a licence key at all: wrong shape or failed checksum. */
export class InvalidKeyError extends LicenseError {
  constructor(message: string) {
    super(message, 'invalid_key');
  }
}

/** The serialiser was handed something it cannot render identically in both editions. */
export class CanonicalJsonError extends LicenseError {
  constructor(message: string) {
    super(message, 'canonical_json');
  }
}

/** A signature did not verify, or the envelope was not what it claimed to be. */
export class SignatureError extends LicenseError {
  constructor(message: string) {
    super(message, 'bad_signature');
  }
}

/**
 * The cache could not be read.
 *
 * Never fatal. The caller discards the file and carries on as if nothing had
 * been activated yet - a corrupt cache after a power cut must not stop the
 * application from starting.
 */
export class CacheError extends LicenseError {
  constructor(message: string) {
    super(message, 'cache_unreadable');
  }
}

/** The server said no. Carries the HTTP status and the server's own error code. */
export class ApiError extends LicenseError {
  readonly status: number;
  readonly detail: unknown;

  constructor(message: string, status: number, code = 'api_error', detail?: unknown) {
    super(message, code);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Every seat is taken.
 *
 * Carries the list of machines holding one so the application can ask which to
 * free, instead of telling the customer to contact support.
 */
export class SeatLimitError extends ApiError {
  readonly seats: SeatLimitDetail;

  constructor(message: string, seats: SeatLimitDetail) {
    super(message, 409, 'seat_limit', seats);
    this.seats = seats;
  }
}

/**
 * How many seats a licence has, and how many are in use.
 *
 * Named rather than spelled inline, because a caller rendering "3 of 5 in use"
 * needs something to annotate the variable with - and because the same three
 * numbers appear in a snapshot, in a status response and inside a seat-limit
 * error, where three inline copies would drift.
 */
export interface SeatCounts {
  total: number;
  used: number;
  available: number;
}

export interface SeatSummary {
  id: number;
  device_name: string;
  platform: string;
  app_version: string;
  status: string;
  last_seen_at: string;
  activated_at: string;
}

export interface SeatLimitDetail {
  seats: SeatCounts;
  active_seats: SeatSummary[];
}

/**
 * The server asked for a pause.
 *
 * Distinct from a plain {@link ApiError} because the caller can do something
 * specific with it: show "try again in a minute" rather than "something went
 * wrong", and schedule rather than poll. `retryAfterMs` is null when the server
 * sent no usable `Retry-After`.
 *
 * The transport only raises this after it has already retried within its
 * policy, so reaching a caller means the pause was longer than the client was
 * willing to block for.
 */
export class RateLimitError extends ApiError {
  readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null) {
    super(message, 429, 'rate_limited', { retryAfterMs });
    this.retryAfterMs = retryAfterMs;
  }
}

/** The server could not be reached. Distinct from a rejection by the server. */
export class NetworkError extends LicenseError {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message, 'network');
    this.cause = cause;
  }
}

/** An operation needs an activated device and there is none. */
export class NotActivatedError extends LicenseError {
  constructor(message = 'This installation is not activated') {
    super(message, 'not_activated');
  }
}
