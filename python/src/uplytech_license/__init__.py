"""``uplytech-license-client`` - the client half of the UplyTech licence system.

One activation per computer, an offline window that survives a flight, and a
signed answer the application can trust without asking again. Used by the
Discord bots for entitlement lookups and by any Python tool that ships as an
installable::

    from uplytech_license import FileStorage, LicenseClient

    licence = LicenseClient(
        api_base_url="https://api.uplytech.de",
        product_slug="vectobeat",
        app_version="1.4.0",
        public_keys={"lk_2026_01": PUBLIC_KEY},
        storage=FileStorage(Path.home() / ".vectobeat" / "licence.bin"),
    )

    licence.ensure()
    if not licence.evaluation.can_run:
        raise SystemExit("Not licensed")

The TypeScript edition of this package implements the same behaviour, pinned by
the same vectors in ``shared/testcases``.
"""

from .canonical_json import MAX_SAFE_INTEGER, canonical_json, canonical_json_bytes
from .client import LicenseClient
from .crypto import (
    CACHE_AAD_PREFIX,
    CACHE_INFO_PREFIX,
    CACHE_SALT,
    derive_cache_key,
    open_sealed,
    seal_with_nonce,
)
from .errors import (
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
)
from .events import LicenseEvent, LicenseEventListener, emit
from .features import FeatureIndex, granted_from, has_feature
from .fingerprint import (
    COMPONENT_WEIGHTS,
    STABLE_COMPONENTS,
    TOTAL_WEIGHT,
    FingerprintMatch,
    combine_fingerprint,
    compare_components,
    hash_component,
    hash_components,
    is_valid_fingerprint,
)
from .key import (
    ALPHABET,
    BODY_SYMBOLS,
    BRAND_PREFIX,
    check_symbol,
    format_key,
    has_valid_check_symbol,
    is_valid_key,
    normalise_key,
    parse_key,
)
from .retry import (
    DEFAULT_RETRY,
    NO_RETRY,
    RetryPolicy,
    backoff_seconds,
    is_retryable_status,
    parse_retry_after,
)
from .semver import (
    ParsedVersion,
    compare_parsed,
    compare_versions,
    is_valid_version,
    parse_version,
    version_within,
)
from .signature import ALGORITHM, b64url_decode, b64url_encode, peek_claims, verify_envelope
from .state import (
    DEFAULT_CLOCK_TOLERANCE_HOURS,
    ClockCheck,
    Evaluation,
    LicenseState,
    check_clock,
    evaluate,
)
from .storage import FileStorage, MemoryStorage, Storage
from .transport import Transport, normalise_api_url
from .types import (
    CachedLicense,
    DeviceIdentity,
    EntitlementResult,
    LicenseSnapshot,
    SeatCounts,
)

__version__ = "2.0.0"

__all__ = [
    "ALGORITHM",
    "ALPHABET",
    "ApiError",
    "BODY_SYMBOLS",
    "BRAND_PREFIX",
    "CACHE_AAD_PREFIX",
    "CACHE_INFO_PREFIX",
    "CACHE_SALT",
    "COMPONENT_WEIGHTS",
    "CacheError",
    "CachedLicense",
    "CanonicalJsonError",
    "ClockCheck",
    "DEFAULT_CLOCK_TOLERANCE_HOURS",
    "DEFAULT_RETRY",
    "DeviceIdentity",
    "EntitlementResult",
    "Evaluation",
    "FeatureIndex",
    "FileStorage",
    "FingerprintMatch",
    "InvalidKeyError",
    "LicenseClient",
    "LicenseError",
    "LicenseEvent",
    "LicenseEventListener",
    "LicenseSnapshot",
    "LicenseState",
    "MAX_SAFE_INTEGER",
    "MemoryStorage",
    "NO_RETRY",
    "NetworkError",
    "NotActivatedError",
    "ParsedVersion",
    "RateLimitError",
    "RetryPolicy",
    "STABLE_COMPONENTS",
    "SeatCounts",
    "SeatLimitError",
    "SignatureError",
    "Storage",
    "TOTAL_WEIGHT",
    "Transport",
    "ValidationError",
    "__version__",
    "b64url_decode",
    "b64url_encode",
    "backoff_seconds",
    "canonical_json",
    "canonical_json_bytes",
    "check_clock",
    "check_symbol",
    "combine_fingerprint",
    "compare_components",
    "compare_parsed",
    "compare_versions",
    "derive_cache_key",
    "emit",
    "evaluate",
    "format_key",
    "granted_from",
    "has_feature",
    "has_valid_check_symbol",
    "hash_component",
    "hash_components",
    "is_retryable_status",
    "is_valid_fingerprint",
    "is_valid_key",
    "is_valid_version",
    "normalise_api_url",
    "normalise_key",
    "open_sealed",
    "parse_key",
    "parse_retry_after",
    "parse_version",
    "peek_claims",
    "seal_with_nonce",
    "verify_envelope",
    "version_within",
]
