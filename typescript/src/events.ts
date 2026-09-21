/**
 * The one place this library says out loud what it just did.
 *
 * Everything else here fails quietly on purpose. A corrupt cache is discarded
 * without a word, because the only useful response is the activation dialog. A
 * network failure inside the offline window is not an error at all. A retry
 * happens and nobody is told. Those are the right behaviours for the customer
 * sitting in front of the application - and they are exactly the behaviours
 * that make a support ticket unanswerable, because the one machine where the
 * problem happens is the one machine nobody can attach a debugger to.
 *
 * So: a single optional callback. No logger interface to implement, no
 * dependency, no format to agree on. It hands over a discriminated union that a
 * caller can pattern-match, forward to Sentry, or drop into its own log.
 *
 * **Nothing here ever carries a credential**, a token, a licence key or a raw
 * hardware value. Fingerprints appear only as the already-hashed form, and only
 * where a support engineer needs to compare two of them.
 */

/** Everything this client will tell you about, if you ask. */
export type LicenseEvent =
  | { type: 'cache.loaded'; state: string }
  | { type: 'cache.missing' }
  | {
      type: 'cache.discarded';
      /** Why the cache could not be used. Never the file's contents. */
      reason: 'unreadable' | 'wrong-format' | 'wrong-machine' | 'corrupt';
      detail: string;
    }
  | { type: 'cache.written'; bytes: number }
  | { type: 'request.start'; path: string; attempt: number }
  | { type: 'request.ok'; path: string; attempt: number; status: number; durationMs: number }
  | {
      type: 'request.retry';
      path: string;
      attempt: number;
      /** The status that prompted it, or null for a transport failure. */
      status: number | null;
      delayMs: number;
      reason: string;
    }
  | {
      type: 'request.failed';
      path: string;
      attempts: number;
      status: number | null;
      code: string;
    }
  | { type: 'token.refreshed' }
  | { type: 'signature.verified'; keyId: string }
  | { type: 'signature.rejected'; keyId: string | null; reason: string }
  | { type: 'clock.rolledBack'; behindMs: number }
  | { type: 'state.changed'; from: string; to: string; reason: string | null };

export type LicenseEventListener = (event: LicenseEvent) => void;

/**
 * Call a listener without letting it break the caller.
 *
 * A listener that throws - a Sentry client mid-initialisation, a log handler
 * with a full disk - must not turn into a licence failure. Observability is
 * never allowed to be the thing that stops an application starting.
 */
export function emit(listener: LicenseEventListener | undefined, event: LicenseEvent): void {
  if (!listener) return;
  try {
    listener(event);
  } catch {
    // Deliberately swallowed, and deliberately not re-reported through the
    // same listener that just failed.
  }
}
