#!/usr/bin/env node
/**
 * Both editions answer the same questions, and every part of one is there.
 *
 * The shared vectors prove the two halves agree about what they *compute*.
 * Nothing proved they agree about what they *offer* - and this package is used
 * from an Electron main process on one side and a Discord bot on the other, by
 * people who read one README and expect the other edition to match. A method
 * that exists only in TypeScript is a support ticket that opens six months
 * later, in a language nobody is looking at.
 *
 * Two failures this catches, neither of which any other check does:
 *
 * **A name in one edition and not the other.** Writing 2.0.0 added twelve
 * methods to the client; every one of them had to be added twice, and the only
 * reason nobody forgot is that this file counts them.
 *
 * **A capability that quietly loses a piece.** The list below is the shape of a
 * complete licence client, written down. If a refactor drops `release_seat` or
 * `verify_subjects` from the public surface, this fails and names it, rather
 * than the gap being found by somebody who needed it.
 *
 * The list is deliberately spelled out rather than derived. A check that reads
 * the answer off the thing it is checking is not a check.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The shape of a complete licence client, by area. */
const SURFACE = {
  "The client": ["LicenseClient", "FileStorage", "MemoryStorage", "Storage"],
  "Activation and check-in": [
    "activate",
    "start_trial",
    "heartbeat",
    "ensure",
    "deactivate",
    "load",
    "reset",
    "device_status",
  ],
  "Seats and ownership": [
    "list_seats",
    "release_seat",
    "list_licenses",
    "get_license",
    "reveal_key",
  ],
  Entitlement: ["verify_subject", "verify_subjects"],
  "Reading the decision": [
    "evaluate",
    "check_clock",
    "LicenseState",
    "Evaluation",
    "ClockCheck",
    "DEFAULT_CLOCK_TOLERANCE_HOURS",
  ],
  Features: ["has_feature", "granted_from", "FeatureIndex"],
  "The update window": [
    "parse_version",
    "compare_versions",
    "compare_parsed",
    "is_valid_version",
    "version_within",
    "ParsedVersion",
  ],
  "Licence keys": [
    "ALPHABET",
    "BODY_SYMBOLS",
    "BRAND_PREFIX",
    "check_symbol",
    "format_key",
    "has_valid_check_symbol",
    "is_valid_key",
    "normalise_key",
    "parse_key",
  ],
  Fingerprints: [
    "COMPONENT_WEIGHTS",
    "STABLE_COMPONENTS",
    "TOTAL_WEIGHT",
    "combine_fingerprint",
    "compare_components",
    "hash_component",
    "hash_components",
    "is_valid_fingerprint",
    "FingerprintMatch",
  ],
  Signatures: [
    "ALGORITHM",
    "b64url_decode",
    "b64url_encode",
    "peek_claims",
    "verify_envelope",
  ],
  "The sealed cache": [
    "CACHE_AAD_PREFIX",
    "CACHE_INFO_PREFIX",
    "CACHE_SALT",
    "derive_cache_key",
    "seal_with_nonce",
  ],
  "Deterministic JSON": ["canonical_json", "canonical_json_bytes"],
  Transport: ["Transport", "normalise_api_url"],
  Retrying: [
    "DEFAULT_RETRY",
    "NO_RETRY",
    "RetryPolicy",
    "is_retryable_status",
    "parse_retry_after",
  ],
  Observability: ["LicenseEvent", "LicenseEventListener", "emit"],
  Errors: [
    "LicenseError",
    "ApiError",
    "CacheError",
    "CanonicalJsonError",
    "InvalidKeyError",
    "NetworkError",
    "NotActivatedError",
    "RateLimitError",
    "SeatLimitError",
    "SignatureError",
    "ValidationError",
  ],
};

/**
 * Names that are deliberately spelled differently, and why.
 *
 * Every entry here is a decision somebody made on purpose. An empty entry would
 * mean the two editions had drifted and nobody wrote down which one was right.
 */
const RENAMED = {
  // Python's `open` would shadow the builtin inside the module that defines it,
  // so the sealed cache reader is `open_sealed` there and `openCache` on the
  // entry point in TypeScript, where `open` is not taken but is far too vague.
  open_sealed: "openCache",
  // `backoff_seconds` and `backoffMs` differ in name because they differ in
  // unit: Python's sleep takes seconds, JavaScript's setTimeout milliseconds,
  // and a shared name over different units is how somebody sleeps for
  // sixteen minutes.
  backoff_seconds: "backoffMs",
  // Python's dataclasses carry their own conversion; the TypeScript side is a
  // plain interface, so the name is all there is to match.
  DeviceIdentity: "DeviceIdentity",
  SeatCounts: "SeatCounts",
  CachedLicense: "CachedLicense",
  LicenseSnapshot: "LicenseSnapshot",
  EntitlementResult: "EntitlementResult",
};

/**
 * Names that exist in one edition on purpose, with the reason.
 *
 * The bar is high: an entry here is a claim that the other edition does not
 * need the name, not that somebody has not got round to it. Two entries after
 * two versions is about right; a growing list would mean the editions are
 * drifting and this file has become a place to record it rather than a check.
 */
const EDITION_ONLY = {
  // JavaScript has Number.MAX_SAFE_INTEGER built in. Exporting a second one
  // would be a name for a constant the language already names.
  MAX_SAFE_INTEGER: "TypeScript has Number.MAX_SAFE_INTEGER",
};

/** snake_case to camelCase, which is the only difference for most names. */
function camel(name) {
  return name.replace(/_([a-z0-9])/g, (_match, character) => character.toUpperCase());
}

function pythonExports() {
  const out = execFileSync(
    process.platform === "win32" ? "python" : "python3",
    ["-c", "import json, uplytech_license as m; print(json.dumps(sorted(m.__all__)))"],
    {
      cwd: join(root, "python"),
      env: { ...process.env, PYTHONPATH: "src" },
      encoding: "utf8",
    },
  );
  return new Set(JSON.parse(out));
}

function typescriptExports() {
  // Every identifier the entry point re-exports. Read as a word list rather
  // than parsed: this asks "is the name there", not "what shape is it".
  const text = readFileSync(join(root, "typescript", "src", "index.ts"), "utf8");
  return new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

/**
 * The client's own methods, which are not exports and still have to match.
 *
 * A method missing on one side is exactly the gap this file exists for, and
 * `__all__` says nothing about them.
 */
function pythonMethods() {
  const out = execFileSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-c",
      "import json; from uplytech_license import LicenseClient as c; " +
        "print(json.dumps(sorted(n for n in dir(c) if not n.startswith('_'))))",
    ],
    {
      cwd: join(root, "python"),
      env: { ...process.env, PYTHONPATH: "src" },
      encoding: "utf8",
    },
  );
  return new Set(JSON.parse(out));
}

function typescriptMethods() {
  const text = readFileSync(join(root, "typescript", "src", "client.ts"), "utf8");
  const names = new Set();
  for (const match of text.matchAll(
    /^\s{2}(?:async\s+)?(?:get\s+)?([a-z][A-Za-z0-9]*)\s*[(:]/gm,
  )) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/^\s{2}readonly\s+([a-z][A-Za-z0-9]*)/gm)) {
    names.add(match[1]);
  }
  return names;
}

const python = new Set([...pythonExports(), ...pythonMethods()]);
const typescript = new Set([...typescriptExports(), ...typescriptMethods()]);

/** What TypeScript should be calling a name Python spells this way. */
function counterpart(name) {
  return RENAMED[name] ?? (name === name.toUpperCase() ? name : camel(name));
}

let failed = false;
let checked = 0;

for (const [area, names] of Object.entries(SURFACE)) {
  const missing = [];
  for (const name of names) {
    checked += 1;
    if (!python.has(name)) missing.push(`${name} (Python)`);
    const other = counterpart(name);
    if (!typescript.has(other) && !typescript.has(name)) missing.push(`${other} (TypeScript)`);
  }
  if (missing.length > 0) {
    failed = true;
    console.error(`::error::${area} is incomplete: ${missing.join(", ")}`);
  } else {
    console.log(`ok - ${area} (${names.length})`);
  }
}

// A name Python offers and TypeScript does not is the gap a porting caller
// falls into. The reverse is checked by the areas above, which are written in
// the Python spelling.
const unmatched = [];
for (const name of python) {
  if (name.startsWith("__")) continue;
  if (name in EDITION_ONLY) continue;
  const other = counterpart(name);
  if (!typescript.has(other) && !typescript.has(name)) unmatched.push(name);
}
if (unmatched.length > 0) {
  failed = true;
  console.error(
    `::error::${unmatched.length} Python name(s) have no TypeScript counterpart: ` +
      `${unmatched.join(", ")}. Add it there, or rename it here and record the ` +
      `pair in RENAMED with the reason.`,
  );
}

if (failed) process.exit(1);
const deliberate = Object.entries(EDITION_ONLY)
  .map(([name, reason]) => `${name} (${reason})`)
  .join(", ");
console.log(
  `ok - ${Object.keys(SURFACE).length} areas, ${checked} names, present in both editions` +
    (deliberate ? `; deliberately one-sided: ${deliberate}` : ""),
);
