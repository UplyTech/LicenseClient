/**
 * Device fingerprints - the arithmetic.
 *
 * Every component is hashed before it leaves the machine. Host names, MAC
 * addresses and user names are personal data; the server has no business
 * holding them and this library never sends them.
 *
 * Nothing here touches the operating system. The probing lives in `probe.ts`,
 * which cannot be tested on a machine that is not the one it is probing - so
 * keeping the two apart is what makes this file provable against the shared
 * vectors.
 */

import { createHash } from 'node:crypto';

/**
 * What a component is worth as evidence.
 *
 * Mirrors `COMPONENT_WEIGHTS` in the API, which is what actually decides
 * whether a changed machine rebinds its seat or consumes a new one. The
 * machine id and the mainboard survive almost everything; the network address
 * barely survives a train journey.
 */
export const COMPONENT_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  machine_id: 3,
  board: 3,
  disk: 2,
  cpu: 1,
  mac: 1,
  user: 1,
  install_id: 1,
});

export const TOTAL_WEIGHT = Object.values(COMPONENT_WEIGHTS).reduce((sum, w) => sum + w, 0);

/**
 * The components that go into the combined fingerprint.
 *
 * `install_id` is left out on purpose: it changes on a reinstall, and the seat
 * should survive one. It still counts as evidence during a rebind.
 */
export const STABLE_COMPONENTS = ['machine_id', 'board', 'disk', 'cpu', 'mac', 'user'] as const;

export type ComponentMap = Record<string, string>;

export function hashComponent(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Combine already-hashed components into the fingerprint.
 *
 * Sorted by component name and joined with a separator, so the order in which
 * the machine happened to report them is irrelevant. Unknown component names
 * are ignored: a newer client version reporting something extra must not shift
 * the fingerprint of installations that have been running for a year.
 */
export function combineFingerprint(hashedComponents: ComponentMap): string {
  const stable = new Set<string>(STABLE_COMPONENTS);
  const names = Object.keys(hashedComponents)
    .filter((name) => stable.has(name) && hashedComponents[name])
    .sort();
  const joined = names.map((name) => hashedComponents[name]).join('|');
  return createHash('sha256').update(joined, 'utf8').digest('hex');
}

/** Hash a map of raw values in one go. */
export function hashComponents(raw: ComponentMap): ComponentMap {
  const out: ComponentMap = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value) out[name] = hashComponent(value);
  }
  return out;
}

export interface FingerprintMatch {
  weight: number;
  matched: string[];
  changed: string[];
  /** Match strength as a percentage of the maximum weight. */
  stability: number;
}

/**
 * Weighted comparison of two component maps.
 *
 * A component missing on either side counts as neither a match nor a mismatch.
 * An older client version simply does not report everything, and punishing
 * that would make every upgrade look like a new machine.
 */
export function compareComponents(stored: ComponentMap, presented: ComponentMap): FingerprintMatch {
  const matched: string[] = [];
  const changed: string[] = [];
  let weight = 0;

  for (const [component, componentWeight] of Object.entries(COMPONENT_WEIGHTS)) {
    const left = stored[component];
    const right = presented[component];
    if (!left || !right) continue;
    if (left === right) {
      matched.push(component);
      weight += componentWeight;
    } else {
      changed.push(component);
    }
  }

  return {
    weight,
    matched,
    changed,
    // The guard is for a weight table edited down to nothing, which the
    // constant above makes impossible today - it is here so that emptying the
    // table produces a zero rather than a NaN percentage in a support report.
    /* v8 ignore next */
    stability: TOTAL_WEIGHT ? Math.round((weight * 100) / TOTAL_WEIGHT) : 0,
  };
}

/** A SHA-256 digest in lower-case hex. */
export function isValidFingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
