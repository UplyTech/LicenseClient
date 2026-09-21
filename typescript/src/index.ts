/**
 * `@uplytech/license-client` - the client half of the UplyTech licence system.
 *
 * One activation per computer, an offline window that survives a flight, and a
 * signed answer the application can trust without asking again. Used by
 * TeamProManager, FlashTrix and anything else that ships as an installable.
 *
 *     const licence = new LicenseClient({
 *       apiBaseUrl: 'https://api.uplytech.de',
 *       productSlug: 'teampromanager',
 *       appVersion: app.getVersion(),
 *       publicKeys: { lk_2026_01: PUBLIC_KEY },
 *       storage: new FileStorage(join(app.getPath('userData'), 'licence.bin')),
 *     });
 *
 *     await licence.ensure();
 *     if (!licence.evaluation.canRun) showActivationDialog();
 */

export { LicenseClient } from './client.js';
export { FileStorage, MemoryStorage } from './storage.js';

export {
  ALPHABET,
  BODY_SYMBOLS,
  BRAND_PREFIX,
  checkSymbol,
  formatKey,
  hasValidCheckSymbol,
  isValidKey,
  normaliseKey,
  parseKey,
  type ParsedKey,
} from './key.js';

export {
  COMPONENT_WEIGHTS,
  STABLE_COMPONENTS,
  TOTAL_WEIGHT,
  combineFingerprint,
  compareComponents,
  hashComponent,
  hashComponents,
  isValidFingerprint,
  type ComponentMap,
  type FingerprintMatch,
} from './fingerprint.js';

export {
  collectComponents,
  detectVirtualMachine,
  identifyDevice,
  type DeviceIdentity,
} from './probe.js';

export { FeatureIndex, grantedFrom, hasFeature } from './features.js';

export { emit, type LicenseEvent, type LicenseEventListener } from './events.js';

export {
  DEFAULT_RETRY,
  NO_RETRY,
  backoffMs,
  delay,
  isRetryableStatus,
  parseRetryAfter,
  type RetryPolicy,
} from './retry.js';

export {
  compareParsed,
  compareVersions,
  isValidVersion,
  parseVersion,
  versionWithin,
  type ParsedVersion,
} from './semver.js';

export {
  DEFAULT_CLOCK_TOLERANCE_HOURS,
  checkClock,
  evaluate,
  type ClockCheck,
  type Evaluation,
  type LicenseState,
} from './state.js';

export {
  ALGORITHM,
  b64urlDecode,
  b64urlEncode,
  peekClaims,
  verifyEnvelope,
  type SignedEnvelope,
} from './signature.js';

export {
  CACHE_AAD_PREFIX,
  CACHE_INFO_PREFIX,
  CACHE_SALT,
  deriveCacheKey,
  open as openCache,
  sealWithNonce,
} from './crypto.js';

export { canonicalJson, canonicalJsonBytes, type CanonicalValue } from './canonical-json.js';

export {
  Transport,
  normaliseApiUrl,
  type RequestOptions,
  type TransportOptions,
} from './transport.js';

export {
  ApiError,
  CacheError,
  CanonicalJsonError,
  InvalidKeyError,
  LicenseError,
  NetworkError,
  NotActivatedError,
  RateLimitError,
  SeatLimitError,
  SignatureError,
  ValidationError,
  type SeatCounts,
  type SeatLimitDetail,
  type SeatSummary,
} from './errors.js';

export type {
  ActivationResponse,
  CachedLicense,
  EntitlementResult,
  LicenseClientOptions,
  LicenseSnapshot,
  LicenseStatus,
  LicenseStatusResponse,
  LicenseType,
  OwnedLicense,
  OwnedLicenseList,
  Seat,
  Storage,
  SubjectRef,
} from './types.js';
