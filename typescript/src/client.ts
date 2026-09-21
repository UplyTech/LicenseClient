/**
 * The one class an application talks to.
 *
 * Everything below it is pure and separately tested; this file is the wiring:
 * probe the machine, seal and unseal the cache, call the server, and decide
 * what the answer means.
 *
 * The rule that shapes the whole design: **a network failure is not a licence
 * failure**. If the server cannot be reached and the cache is still inside its
 * offline window, the application carries on. Anything else turns a flaky
 * connection into a support ticket.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';
import { open, sealWithNonce } from './crypto.js';
import {
  ApiError,
  CacheError,
  NetworkError,
  NotActivatedError,
  SignatureError,
  ValidationError,
} from './errors.js';
import { emit } from './events.js';
import { FeatureIndex } from './features.js';
import { identifyDevice, type DeviceIdentity } from './probe.js';
import { NO_RETRY } from './retry.js';
import { verifyEnvelope, type SignedEnvelope } from './signature.js';
import { checkClock, evaluate, type Evaluation, type LicenseState } from './state.js';
import { Transport, normaliseApiUrl } from './transport.js';
import type {
  ActivationResponse,
  CachedLicense,
  EntitlementResult,
  LicenseClientOptions,
  LicenseSnapshot,
  LicenseStatusResponse,
  OwnedLicense,
  OwnedLicenseList,
  Seat,
  Storage,
  SubjectRef,
} from './types.js';

const NONCE_BYTES = 12;
const CACHE_FORMAT = 1;

/** The server's own cap on `verify/bulk`. Refusing here beats reading a 422 back. */
const MAX_BULK_SUBJECTS = 100;

interface CacheContainer {
  v: number;
  alg: 'AES-256-GCM';
  nonce: string;
  ciphertext: string;
}

export class LicenseClient {
  readonly productSlug: string;
  readonly apiBaseUrl: string;

  private readonly options: LicenseClientOptions;
  private readonly storage: Storage;
  private readonly transport: Transport;
  private readonly now: () => Date;
  private readonly device: DeviceIdentity;

  private cache: CachedLicense | null = null;
  private loaded = false;

  /**
   * The last evaluation, and what it was computed from.
   *
   * `evaluation` is a getter that an application reads from menu-enable code
   * and render paths, and every read parses five ISO timestamps and runs the
   * clock check. Caching it on the snapshot's identity and the current second
   * makes repeated reads free without ever letting the answer go stale: a
   * licence that expires does so at a second boundary, and a snapshot that
   * changes is a different object.
   */
  private memo: { snapshot: LicenseSnapshot | null; second: number; value: Evaluation } | null =
    null;

  /** Rebuilt whenever the snapshot's feature list changes. See {@link FeatureIndex}. */
  private features: { source: readonly string[]; index: FeatureIndex } | null = null;

  /**
   * The heartbeat currently in flight, if any.
   *
   * An Electron application with three windows calls `ensure()` three times at
   * start-up; a bot with a scheduler and a command handler does the same. Every
   * one of those would be a separate round trip, a separate nonce and a
   * separate cache write, and the last one to finish would win. Sharing the
   * promise makes concurrent callers one caller.
   */
  private inFlight: Promise<Evaluation> | null = null;

  constructor(options: LicenseClientOptions) {
    this.options = options;
    this.productSlug = options.productSlug;
    this.apiBaseUrl = normaliseApiUrl(options.apiBaseUrl);
    this.storage = options.storage;
    this.now = options.now ?? (() => new Date());
    this.transport = new Transport(
      this.apiBaseUrl,
      options.fetch ?? globalThis.fetch,
      options.requestTimeoutMs,
      { retry: options.retry, onEvent: options.onEvent },
    );

    if (options.device) {
      this.device = {
        fingerprint: options.device.fingerprint,
        components: options.device.components,
        installId: options.installId,
        name: options.device.name ?? '',
        platform: options.device.platform ?? '',
        osVersion: options.device.osVersion ?? '',
        vmSuspected: options.device.vmSuspected ?? false,
      };
    } else {
      // Probing the real machine shells out to the operating system it is
      // running on. It cannot be exercised for Windows, macOS and Linux from
      // one machine - the same reason probe.ts is excluded from coverage - and
      // a mock here would only test the mock.
      /* v8 ignore start */
      this.device = identifyDevice(options.installId);
      /* v8 ignore stop */
    }
  }

  // ---------------------------------------------------------------------------
  // Reading the current situation
  // ---------------------------------------------------------------------------

  get fingerprint(): string {
    return this.device.fingerprint;
  }

  get snapshot(): LicenseSnapshot | null {
    return this.cache?.snapshot ?? null;
  }

  /** The current decision. Call {@link load} first, or it reports NOT_ACTIVATED. */
  get evaluation(): Evaluation {
    const snapshot = this.snapshot;
    const now = this.now();
    const second = Math.floor(now.getTime() / 1_000);

    if (this.memo && this.memo.snapshot === snapshot && this.memo.second === second) {
      return this.memo.value;
    }

    const value = evaluate(snapshot, now, {
      fingerprint: this.device.fingerprint,
      clockToleranceHours: this.options.clockToleranceHours,
      appVersion: this.options.appVersion,
    });

    if (this.memo && this.memo.value.state !== value.state) {
      emit(this.options.onEvent, {
        type: 'state.changed',
        from: this.memo.value.state,
        to: value.state,
        reason: value.reason,
      });
    }

    this.memo = { snapshot, second, value };
    return value;
  }

  get state(): LicenseState {
    return this.evaluation.state;
  }

  /**
   * Whether the licence covers a feature. False whenever it may not run.
   *
   * The "may not run" half is not a convenience. An application that checks
   * `hasFeature` but forgets `canRun` would keep its paid features working
   * after the licence was revoked, which is the one mistake this method exists
   * to make impossible.
   */
  hasFeature(feature: string): boolean {
    if (!this.evaluation.canRun) return false;
    return this.featureIndex().has(feature);
  }

  /** Every feature in `wanted` the licence covers. Empty whenever it may not run. */
  grantedFeatures(wanted: readonly string[]): string[] {
    if (!this.evaluation.canRun) return [];
    return this.featureIndex().granted(wanted);
  }

  private featureIndex(): FeatureIndex {
    const source = this.snapshot?.features ?? [];
    if (!this.features || this.features.source !== source) {
      this.features = { source, index: new FeatureIndex(source) };
    }
    return this.features.index;
  }

  // ---------------------------------------------------------------------------
  // What to put in front of a person
  // ---------------------------------------------------------------------------

  /**
   * Whole days until the licence expires, or null for one that does not.
   *
   * Rounded down, so "1 day left" means at least one full day. An application
   * showing a renewal banner wants this rather than the raw timestamp, and
   * rounding it in two places is how the banner and the lock disagree by a day.
   */
  get daysUntilExpiry(): number | null {
    const expires = this.snapshot?.expiresAt;
    if (!expires) return null;
    const at = Date.parse(expires);
    if (Number.isNaN(at)) return null;
    return Math.floor((at - this.now().getTime()) / 86_400_000);
  }

  /**
   * The server's own warnings, unchanged.
   *
   * Stable identifiers - `expires_in_7_days`, `clock_skew`, `vm_detected` - so
   * an application looks them up in its own message table and translates them.
   * Turning them into sentences here would mean shipping English into every
   * localised product.
   */
  get warnings(): readonly string[] {
    return this.snapshot?.warnings ?? [];
  }

  /** Whether the machine this is running on is inside the licence's update window. */
  get versionCovered(): boolean {
    return this.evaluation.state !== 'LOCKED_VERSION';
  }

  // ---------------------------------------------------------------------------
  // Cache
  // ---------------------------------------------------------------------------

  /**
   * Read the cache. Never throws for a damaged one.
   *
   * A corrupt cache after a power cut, a file copied from another machine, a
   * format from a future version - all of it means the same thing: forget it
   * and behave as if nothing had been activated. Refusing to start would turn
   * a full disk into a licence problem.
   */
  async load(): Promise<Evaluation> {
    this.loaded = true;
    this.cache = null;
    this.memo = null;
    this.features = null;

    const raw = await this.storage.read();
    if (!raw) {
      emit(this.options.onEvent, { type: 'cache.missing' });
      return this.evaluation;
    }

    let discarded: 'unreadable' | 'wrong-format' | 'wrong-machine' | 'corrupt' = 'corrupt';
    let detail = '';
    try {
      const container = JSON.parse(Buffer.from(raw).toString('utf8')) as CacheContainer;
      if (container?.v !== CACHE_FORMAT) {
        discarded = 'wrong-format';
        throw new CacheError(`Unknown cache format ${String(container?.v)}`);
      }
      discarded = 'wrong-machine';
      const plaintext = open(
        Buffer.from(container.ciphertext, 'base64'),
        this.device.fingerprint,
        this.productSlug,
        Buffer.from(container.nonce, 'base64'),
      );
      discarded = 'unreadable';
      const parsed = JSON.parse(plaintext.toString('utf8')) as CachedLicense;
      if (parsed?.version !== CACHE_FORMAT || !parsed.snapshot) {
        throw new CacheError('Cache contents are not what this version writes');
      }
      this.cache = parsed;
    } catch (error) {
      // Silent to the *caller*, on purpose: it sees NOT_ACTIVATED and offers
      // the activation dialog, which is the only useful thing to do about a
      // cache that will not open. The event is how a support engineer finds out
      // which of the four reasons it was, on a machine they cannot debug.
      detail = error instanceof Error ? error.message : String(error);
      emit(this.options.onEvent, { type: 'cache.discarded', reason: discarded, detail });
      await this.storage.clear();
      this.cache = null;
      return this.evaluation;
    }

    // Advance the clock mark on every load, not only on a heartbeat.
    //
    // Without this, an application started offline on Monday and quit on Friday
    // leaves a mark from Monday - and Friday's user can wind the clock back four
    // days to reopen an offline window. Moving it forward whenever the client
    // sees a later time closes that, and it only ever moves forward, so it can
    // never shorten a window either.
    const advanced = checkClock(
      this.now(),
      this.cache.snapshot.clockHighWater,
      this.options.clockToleranceHours,
    );
    if (advanced.newHighWater !== this.cache.snapshot.clockHighWater) {
      this.cache.snapshot = { ...this.cache.snapshot, clockHighWater: advanced.newHighWater };
      // Best effort. A read-only disk must not stop the application starting;
      // the mark simply does not advance until it can be written.
      await this.persist().catch(() => undefined);
    }
    if (advanced.rolledBack) {
      emit(this.options.onEvent, {
        type: 'clock.rolledBack',
        behindMs: Date.parse(advanced.newHighWater) - this.now().getTime(),
      });
    }

    const evaluation = this.evaluation;
    emit(this.options.onEvent, { type: 'cache.loaded', state: evaluation.state });
    return evaluation;
  }

  private async persist(): Promise<void> {
    // Writing "no licence" means removing the file, not sealing an empty one.
    // Every caller already checks, so this is the belt to that pair of braces -
    // it is what keeps a future caller from writing a cache whose snapshot is
    // null, which would then fail to load on every start.
    /* v8 ignore start */
    if (!this.cache) {
      await this.storage.clear();
      return;
    }
    /* v8 ignore stop */
    const nonce = randomBytes(NONCE_BYTES);
    const plaintext = Buffer.from(canonicalJson(this.cache as never), 'utf8');
    const ciphertext = sealWithNonce(plaintext, this.device.fingerprint, this.productSlug, nonce);
    const container: CacheContainer = {
      v: CACHE_FORMAT,
      alg: 'AES-256-GCM',
      nonce: nonce.toString('base64'),
      ciphertext: Buffer.from(ciphertext).toString('base64'),
    };
    const bytes = Buffer.from(JSON.stringify(container), 'utf8');
    await this.storage.write(bytes);
    emit(this.options.onEvent, { type: 'cache.written', bytes: bytes.length });
  }

  /** Forget everything locally. Does not free the seat - use {@link deactivate}. */
  async reset(): Promise<void> {
    this.cache = null;
    this.memo = null;
    this.features = null;
    await this.storage.clear();
  }

  // ---------------------------------------------------------------------------
  // Talking to the server
  // ---------------------------------------------------------------------------

  private devicePayload(): Record<string, unknown> {
    return {
      fingerprint: this.device.fingerprint,
      components: this.device.components,
      install_id: this.device.installId ?? null,
      name: this.device.name,
      platform: this.device.platform,
      os_version: this.device.osVersion,
      app_version: this.options.appVersion,
      vm_suspected: this.device.vmSuspected,
    };
  }

  /**
   * Activate this machine against a licence key.
   *
   * `subject` overrides the one given to the constructor, for a product whose
   * licence belongs to a Discord guild or a team rather than to a computer.
   */
  async activate(licenseKey: string, subject?: SubjectRef): Promise<Evaluation> {
    const nonce = randomUUID();
    const response = await this.transport.request<ActivationResponse>(
      '/licenses/device/activate',
      {
        method: 'POST',
        body: {
          license_key: licenseKey,
          product_slug: this.productSlug,
          nonce,
          client_time: this.now().toISOString(),
          device: this.devicePayload(),
          ...(subject ?? this.options.subject
            ? { subject: subject ?? this.options.subject }
            : {}),
        },
        // A person is watching an activation dialog. Two retries with backoff
        // is the right shape for a background heartbeat and the wrong one here:
        // better a clear message now than four seconds of a spinner.
        retry: NO_RETRY,
      },
    );
    await this.adopt(response, nonce);
    return this.evaluation;
  }

  /**
   * Start a trial. Needs a signed-in user - a trial is granted to an account,
   * not to a machine, or the same computer could start one every fortnight.
   */
  async startTrial(
    userAccessToken: string,
    email?: string,
    subject?: SubjectRef,
  ): Promise<Evaluation> {
    const nonce = randomUUID();
    const response = await this.transport.request<ActivationResponse>('/licenses/device/trial', {
      method: 'POST',
      token: userAccessToken,
      body: {
        product_slug: this.productSlug,
        nonce,
        client_time: this.now().toISOString(),
        device: this.devicePayload(),
        ...(email ? { email } : {}),
        ...(subject ?? this.options.subject ? { subject: subject ?? this.options.subject } : {}),
      },
      retry: NO_RETRY,
    });
    await this.adopt(response, nonce);
    return this.evaluation;
  }

  /**
   * Check in with the server.
   *
   * Refreshes the device token once on a 401 before giving up: the access
   * token lives 24 hours and an application that was closed over a weekend
   * would otherwise ask its user to activate again for no reason.
   */
  async heartbeat(): Promise<Evaluation> {
    if (!this.loaded) await this.load();
    if (!this.cache) throw new NotActivatedError();

    const send = async (token: string): Promise<LicenseStatusResponse> => {
      const nonce = randomUUID();
      const status = await this.transport.request<LicenseStatusResponse>(
        '/licenses/device/heartbeat',
        {
          method: 'POST',
          token,
          body: {
            nonce,
            client_time: this.now().toISOString(),
            fingerprint: this.device.fingerprint,
            app_version: this.options.appVersion,
          },
        },
      );
      return status;
    };

    let status: LicenseStatusResponse;
    try {
      status = await send(this.cache.deviceAccessToken);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      await this.refreshDeviceToken();
      status = await send(this.cache.deviceAccessToken);
    }

    this.cache.snapshot = this.mergeStatus(this.cache.snapshot, status);
    await this.persist();
    return this.evaluation;
  }

  /**
   * The call an application makes at start-up and every few hours.
   *
   * Loads the cache, checks in when one is due, and swallows a network failure
   * as long as the cache still permits running. It never throws for a
   * connection problem; it throws when the server actually said no.
   */
  async ensure(): Promise<Evaluation> {
    if (!this.loaded) await this.load();
    if (!this.cache) return this.evaluation;

    const before = this.evaluation;
    if (!before.shouldCheckIn && before.canRun) return before;

    // Three windows of an Electron application call this at start-up; a bot's
    // scheduler and its command handler do the same. Without this they are
    // three round trips, three nonces and three cache writes racing to be last.
    if (this.inFlight) return this.inFlight;

    const attempt = (async (): Promise<Evaluation> => {
      try {
        return await this.heartbeat();
      } catch (error) {
        if (error instanceof NetworkError) {
          // Offline. The evaluation already knows whether that is still allowed.
          return this.evaluation;
        }
        if (error instanceof ApiError && error.status >= 500) {
          // The server is having a bad day. Not the customer's problem.
          return this.evaluation;
        }
        throw error;
      } finally {
        this.inFlight = null;
      }
    })();

    this.inFlight = attempt;
    return attempt;
  }

  /** Free this machine's seat and forget the licence locally. */
  async deactivate(): Promise<void> {
    if (!this.loaded) await this.load();
    if (!this.cache) return;

    try {
      await this.transport.request<void>('/licenses/device/deactivate', {
        method: 'POST',
        token: this.cache.deviceAccessToken,
      });
    } catch (error) {
      // A seat that cannot be freed right now is better than a client stuck
      // with a licence it has already told the user it removed. The server
      // reclaims stale seats on its own.
      if (!(error instanceof NetworkError) && !(error instanceof ApiError)) throw error;
    }
    await this.reset();
  }

  /**
   * Read the server's view without changing anything.
   *
   * A heartbeat is a write: it moves the seat's `last_seen_at`, extends the
   * offline window and resets `next_check_after`. That makes it the wrong call
   * for a diagnostics screen, a support tool, or a "check now" button somebody
   * can hold down - each of those would quietly extend the very window it is
   * meant to be reporting on.
   *
   * This one only reads. The result is returned rather than adopted, so nothing
   * about the cached decision changes either.
   */
  async deviceStatus(): Promise<LicenseStatusResponse> {
    if (!this.loaded) await this.load();
    if (!this.cache) throw new NotActivatedError();

    const send = async (token: string): Promise<LicenseStatusResponse> =>
      this.transport.request<LicenseStatusResponse>('/licenses/device/status', { token });

    try {
      return await send(this.cache.deviceAccessToken);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      await this.refreshDeviceToken();
      return await send(this.cache.deviceAccessToken);
    }
  }

  // ---------------------------------------------------------------------------
  // Seats, from the owner's side
  //
  // The device endpoints can only ever free *this* machine. These are the ones
  // behind "my laptop died and it is still holding a seat", and they need the
  // signed-in user's token rather than the device's - freeing somebody else's
  // machine is an account-level decision.
  // ---------------------------------------------------------------------------

  /**
   * Every seat on a licence, including released ones.
   *
   * This is what turns {@link SeatLimitError} from a dead end into a dialog:
   * the error already names the machines holding a seat, and this lists them
   * again with their last-seen times so a person can tell which one is the
   * laptop they threw away.
   */
  async listSeats(userAccessToken: string, licenseId: string): Promise<Seat[]> {
    return this.transport.request<Seat[]>(
      `/licenses/${encodeURIComponent(licenseId)}/seats`,
      { token: userAccessToken },
    );
  }

  /**
   * Free a seat held by another machine.
   *
   * Subject to a quota on the server, unlike a device releasing itself: this is
   * the path a shared key would be rotated through, and an unlimited version of
   * it would make the seat limit advisory.
   */
  async releaseSeat(
    userAccessToken: string,
    licenseId: string,
    seatId: number,
  ): Promise<void> {
    await this.transport.request<void>(
      `/licenses/${encodeURIComponent(licenseId)}/seats/${String(seatId)}`,
      { method: 'DELETE', token: userAccessToken },
    );
  }

  // ---------------------------------------------------------------------------
  // The owner's own licences
  // ---------------------------------------------------------------------------

  /** The signed-in user's licences, for an account screen. */
  async listLicenses(
    userAccessToken: string,
    page = 1,
    pageSize = 20,
  ): Promise<OwnedLicenseList> {
    return this.transport.request<OwnedLicenseList>('/licenses', {
      token: userAccessToken,
      query: { page, page_size: pageSize },
    });
  }

  /** One of the signed-in user's licences. */
  async getLicense(userAccessToken: string, licenseId: string): Promise<OwnedLicense> {
    return this.transport.request<OwnedLicense>(
      `/licenses/${encodeURIComponent(licenseId)}`,
      { token: userAccessToken },
    );
  }

  /**
   * Show the customer their own licence key.
   *
   * A key that only ever existed in one email is a key that is gone the moment
   * that mailbox is. The server scopes this to the caller's own account, logs
   * every call, and rate limits the path; the client's only job is not to keep
   * the answer anywhere. It is returned and never cached, never written to the
   * sealed file, and never put into an event.
   */
  async revealKey(userAccessToken: string, licenseId: string): Promise<string> {
    const answer = await this.transport.request<{ license_key: string }>(
      `/licenses/${encodeURIComponent(licenseId)}/key`,
      { method: 'POST', token: userAccessToken, retry: NO_RETRY },
    );
    return answer.license_key;
  }

  // ---------------------------------------------------------------------------
  // Entitlement, for a product that is not per-machine
  //
  // A Discord bot serves thousands of guilds from one process. There is no seat
  // to activate and no cache to keep: the question is "is *this guild*
  // entitled?", asked per command, and the server answers 200 either way so a
  // freemium product can read a plain "not licensed" instead of turning a 404
  // into business logic.
  // ---------------------------------------------------------------------------

  /**
   * Is one subject entitled?
   *
   * Needs a server-to-server API key, not a user token - the caller is a bot,
   * not a person. Answers for an unlicensed subject too, with the free tier's
   * name and features, so there is one code path rather than two.
   */
  async verifySubject(
    apiKey: string,
    subject: SubjectRef,
    productSlug = this.productSlug,
  ): Promise<EntitlementResult> {
    const answer = await this.transport.request<{
      licensed: boolean;
      tier: string;
      features: string[];
      license_id: string | null;
      expires_at: string | null;
      subject: SubjectRef;
    }>('/licenses/verify', {
      token: apiKey,
      query: {
        product_slug: productSlug,
        subject_type: subject.type,
        subject_ref: subject.ref,
      },
    });
    return {
      licensed: answer.licensed,
      tier: answer.tier,
      features: answer.features ?? [],
      licenseId: answer.license_id,
      expiresAt: answer.expires_at,
      subject: answer.subject,
    };
  }

  /**
   * Up to a hundred subjects in one round trip.
   *
   * A bot in five thousand guilds asking one at a time would poll the API to
   * death, and the server caps the batch at a hundred - so this refuses a
   * larger one here rather than sending it and reading the 422 back.
   */
  async verifySubjects(
    apiKey: string,
    refs: readonly string[],
    subjectType = 'discord_guild',
    productSlug = this.productSlug,
  ): Promise<EntitlementResult[]> {
    if (refs.length === 0) return [];
    if (refs.length > MAX_BULK_SUBJECTS) {
      throw new ValidationError(
        `verifySubjects takes at most ${MAX_BULK_SUBJECTS} subjects at a time, got ${refs.length}`,
      );
    }
    const answer = await this.transport.request<
      {
        licensed: boolean;
        tier: string;
        features: string[];
        license_id: string | null;
        expires_at: string | null;
        subject: SubjectRef;
      }[]
    >('/licenses/verify/bulk', {
      method: 'POST',
      token: apiKey,
      body: {
        product_slug: productSlug,
        subject_type: subjectType,
        subject_refs: [...refs],
      },
    });
    return answer.map((row) => ({
      licensed: row.licensed,
      tier: row.tier,
      features: row.features ?? [],
      licenseId: row.license_id,
      expiresAt: row.expires_at,
      subject: row.subject,
    }));
  }

  private async refreshDeviceToken(): Promise<void> {
    if (!this.cache) throw new NotActivatedError();
    const response = await this.transport.request<ActivationResponse>(
      '/licenses/device/token/refresh',
      { method: 'POST', body: { refresh_token: this.cache.deviceRefreshToken } },
    );
    this.cache.deviceAccessToken = response.device_access_token;
    this.cache.deviceRefreshToken = response.device_refresh_token;
    await this.persist();
    emit(this.options.onEvent, { type: 'token.refreshed' });
  }

  // ---------------------------------------------------------------------------
  // Turning a response into a snapshot
  // ---------------------------------------------------------------------------

  private async adopt(response: ActivationResponse, nonce: string): Promise<void> {
    const claims = this.verify(response.signed_license, nonce);

    const now = this.now().toISOString();
    const snapshot: LicenseSnapshot = {
      licenseId: response.license.license_id,
      product: response.license.product,
      type: response.license.type,
      status: response.license.status,
      tier: response.license.tier,
      features: response.license.features ?? [],
      seatId: response.seat_id ?? response.license.seat_id ?? null,
      deviceFingerprint:
        (claims?.device_fingerprint as string | null | undefined) ??
        (response.seat_id === null ? null : this.device.fingerprint),
      notBefore: (claims?.not_before as string | undefined) ?? null,
      expiresAt: response.license.expires_at,
      offlineValidUntil: response.license.offline_valid_until,
      nextCheckAfter: response.license.next_check_after,
      gracePeriodDays: response.license.grace_period_days,
      maxVersion: response.license.max_version,
      lastCheckAt: now,
      clockHighWater: checkClock(this.now(), null, this.options.clockToleranceHours).newHighWater,
      seats: response.license.seats,
      warnings: [...(response.license.warnings ?? []), ...(response.warnings ?? [])],
    };

    this.cache = {
      version: CACHE_FORMAT,
      snapshot,
      deviceAccessToken: response.device_access_token,
      deviceRefreshToken: response.device_refresh_token,
      signedLicense: response.signed_license,
      apiBaseUrl: this.apiBaseUrl,
    };
    this.loaded = true;
    await this.persist();
  }

  private mergeStatus(
    previous: LicenseSnapshot,
    status: LicenseStatusResponse,
  ): LicenseSnapshot {
    const now = this.now();
    return {
      ...previous,
      status: status.status,
      tier: status.tier,
      features: status.features ?? [],
      seatId: status.seat_id ?? previous.seatId,
      expiresAt: status.expires_at,
      offlineValidUntil: status.offline_valid_until,
      nextCheckAfter: status.next_check_after,
      gracePeriodDays: status.grace_period_days,
      maxVersion: status.max_version,
      seats: status.seats,
      warnings: status.warnings ?? [],
      lastCheckAt: now.toISOString(),
      // The mark only ever moves forward, so a heartbeat on a machine whose
      // clock is wrong does not quietly reset the protection.
      clockHighWater: checkClock(now, previous.clockHighWater, this.options.clockToleranceHours)
        .newHighWater,
    };
  }

  /**
   * Verify the envelope, and check that it was issued for *this* request and
   * *this* machine.
   *
   * The signature alone is not enough: a captured older response is a valid
   * signature over stale claims, and a response captured from a colleague's
   * machine is a valid signature over somebody else's seat. The nonce closes
   * the first, the fingerprint the second.
   */
  private verify(
    envelope: SignedEnvelope | null | undefined,
    nonce: string,
  ): Record<string, unknown> | null {
    if (!envelope) {
      // The server runs unsigned in development. There is nothing to verify,
      // and the client simply checks back more often.
      return null;
    }

    const claims = verifyEnvelope(envelope, this.options.publicKeys);

    if (claims.nonce !== nonce) {
      throw new SignatureError('The signed licence answers a different request');
    }

    const bound = claims.device_fingerprint;
    if (typeof bound === 'string' && bound !== this.device.fingerprint) {
      throw new SignatureError('The signed licence was issued for another machine');
    }

    if (claims.product !== this.productSlug) {
      throw new SignatureError(
        `The signed licence is for ${String(claims.product)}, not ${this.productSlug}`,
      );
    }

    return claims;
  }

  /**
   * Re-check the stored envelope, and that it is still *this* licence.
   *
   * The signature alone answers a narrower question than it appears to. A
   * genuine envelope for a different product, or for a different machine, or
   * naming a different licence than the snapshot beside it, all verify
   * perfectly - and all of them mean the cache has been assembled from parts.
   * So the claims are compared against what the snapshot says as well.
   *
   * False rather than throwing: this is a start-up integrity check, and the
   * answer to a failed one is to re-activate, not to crash.
   */
  verifyCachedSignature(): boolean {
    const envelope = this.cache?.signedLicense;
    const snapshot = this.cache?.snapshot;
    if (!envelope || !snapshot) return false;

    let claims: Record<string, unknown>;
    try {
      claims = verifyEnvelope(envelope, this.options.publicKeys);
    } catch (error) {
      emit(this.options.onEvent, {
        type: 'signature.rejected',
        keyId: envelope.key_id ?? null,
        reason: error instanceof Error ? error.message : 'unverifiable',
      });
      return false;
    }

    const mismatch = ((): string | null => {
      if (claims.product !== undefined && claims.product !== this.productSlug) {
        return 'product';
      }
      const bound = claims.device_fingerprint;
      if (typeof bound === 'string' && bound !== this.device.fingerprint) {
        return 'device';
      }
      const licenseId = claims.license_id;
      if (typeof licenseId === 'string' && licenseId !== snapshot.licenseId) {
        return 'licence';
      }
      return null;
    })();

    if (mismatch) {
      emit(this.options.onEvent, {
        type: 'signature.rejected',
        keyId: envelope.key_id,
        reason: `${mismatch} does not match the cached licence`,
      });
      return false;
    }

    emit(this.options.onEvent, { type: 'signature.verified', keyId: envelope.key_id });
    return true;
  }
}
