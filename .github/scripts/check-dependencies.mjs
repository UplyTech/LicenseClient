#!/usr/bin/env node
/**
 * The npm package's runtime dependencies are exactly the agreed set.
 *
 * A dependency a caller inherits is a decision, not a detail. Adding one has to
 * change this file, which means somebody reviews it in the same pull request.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AGREED = new Set([]);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "typescript", "package.json"), "utf8"));
const declared = new Set(Object.keys(manifest.dependencies ?? {}));

const added = [...declared].filter((name) => !AGREED.has(name)).sort();
const removed = [...AGREED].filter((name) => !declared.has(name)).sort();

if (added.length > 0) {
  console.error(
    `::error file=typescript/package.json::new runtime dependency: ${added.join(", ")}`,
  );
  console.error("::error::Add it to .github/scripts/check-dependencies.mjs with the");
  console.error("::error::reason, in the same pull request, so it is reviewed.");
}
if (removed.length > 0) {
  console.error(
    `::error file=typescript/package.json::dependency gone but still agreed: ${removed.join(", ")}`,
  );
}

if (added.length > 0 || removed.length > 0) {
  process.exit(1);
}

console.log(`ok - runtime dependencies are the agreed set (${declared.size})`);
