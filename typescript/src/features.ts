/**
 * Feature lookup.
 *
 * The application asks "may I show the time tracking?" and gets one boolean.
 * Patterns exist so a tier can grant a whole area without listing every switch
 * in it, and so adding a feature to an area does not require reissuing every
 * licence that already covers it.
 */

/**
 * Does the granted set cover this feature?
 *
 * Matching is exact unless a granted entry ends in `*`, which covers any
 * suffix - including the empty one, so `export.*` answers `export.` as well as
 * `export.csv`. It does not cover `export`, and it does not cover `exportable`:
 * a wildcard is a prefix rule, not a substring search.
 *
 * The wildcard is only ever on the granted side. A query is always a literal
 * name, otherwise an application could ask "do I have anything?" and get a yes.
 *
 * A linear scan, which is the right shape for the handful of entries a licence
 * usually carries. A caller asking the same question inside a render loop wants
 * {@link FeatureIndex} instead - same rules, built once.
 */
export function hasFeature(granted: readonly string[], feature: string): boolean {
  if (!feature) return false;

  for (const entry of granted) {
    if (entry === '*') return true;
    if (entry === feature) return true;
    if (entry.endsWith('*')) {
      const stem = entry.slice(0, -1);
      if (stem && feature.startsWith(stem)) return true;
    }
  }
  return false;
}

/** Every feature in `wanted` that the licence covers. */
export function grantedFrom(granted: readonly string[], wanted: readonly string[]): string[] {
  return wanted.filter((feature) => hasFeature(granted, feature));
}

/**
 * The same rules, prepared once for repeated questions.
 *
 * A desktop application asks `hasFeature` from inside menu-enable code and
 * render paths - hundreds of times a second, with the same answer every time.
 * {@link hasFeature} walks the granted list and calls `endsWith` on each entry
 * for every one of those. That is nothing at ten entries and measurable at a
 * few hundred, which a tier with per-report or per-integration switches
 * reaches.
 *
 * The index costs one pass over the list and then answers exact matches from a
 * Set. Only the wildcard entries are still scanned, and there are rarely more
 * than a handful of those.
 *
 * It is built from a snapshot of the granted list. A licence whose features
 * change gets a new index - see how {@link LicenseClient} rebuilds it when the
 * snapshot changes rather than mutating one.
 */
export class FeatureIndex {
  /** True when the licence grants everything, which short-circuits every query. */
  private readonly everything: boolean;
  private readonly exact: ReadonlySet<string>;
  private readonly prefixes: readonly string[];

  constructor(granted: readonly string[]) {
    let everything = false;
    const exact = new Set<string>();
    const prefixes: string[] = [];

    for (const entry of granted) {
      if (entry === '*') {
        everything = true;
        continue;
      }
      if (entry.endsWith('*')) {
        const stem = entry.slice(0, -1);
        // A bare `*` was handled above; an entry that is only a star after
        // trimming would otherwise become an empty prefix matching everything.
        if (stem) prefixes.push(stem);
        continue;
      }
      exact.add(entry);
    }

    this.everything = everything;
    this.exact = exact;
    this.prefixes = prefixes;
  }

  has(feature: string): boolean {
    if (!feature) return false;
    if (this.everything) return true;
    if (this.exact.has(feature)) return true;
    for (const prefix of this.prefixes) {
      if (feature.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Every feature in `wanted` that the licence covers. */
  granted(wanted: readonly string[]): string[] {
    return wanted.filter((feature) => this.has(feature));
  }
}
