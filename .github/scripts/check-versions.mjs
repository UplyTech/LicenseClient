#!/usr/bin/env node
/**
 * One version number, everywhere it is written down.
 *
 * Both editions share one version number and one history. A test suite cannot
 * notice that promise being broken: both suites still pass while npm says 1.2.0
 * and PyPI says 1.1.0. So it is checked here instead.
 *
 * The list below is this package's places. It is data rather than code because
 * packages differ - one that also exports a VERSION constant has five places,
 * and the fifth is exactly the one that drifts, since nothing else reads it.
 *
 * With --expect <version> (used by the release workflow) the pushed tag has to
 * agree with all of them as well. A tag that does not match the code is how a
 * v1.2.0 release ends up containing 1.1.0 on npm.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** [file, regular expression with one capturing group]. */
const SOURCES = [
  [
    "typescript/package.json",
    "\"version\"\\s*:\\s*\"([^\"]+)\""
  ],
  [
    "python/pyproject.toml",
    "^version\\s*=\\s*\"([^\"]+)\""
  ],
  [
    "python/src/uplytech_license/__init__.py",
    "^__version__\\s*=\\s*\"([^\"]+)\""
  ],
  [
    "CHANGELOG.md",
    "^## \\[(\\d+\\.\\d+\\.\\d+[^\\]]*)\\]"
  ]
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const found = {};
for (const [file, pattern] of SOURCES) {
  let text;
  try {
    text = readFileSync(join(root, ...file.split("/")), "utf8");
  } catch {
    console.error(`::error file=${file}::not found`);
    found[file] = undefined;
    continue;
  }
  found[file] = text.match(new RegExp(pattern, "m"))?.[1];
}

const expectedIndex = process.argv.indexOf("--expect");
if (expectedIndex !== -1) {
  const expected = process.argv[expectedIndex + 1]?.replace(/^v/, "");
  if (!expected) {
    console.error("--expect needs a version");
    process.exit(2);
  }
  found["the pushed tag"] = expected;
}

let failed = false;
for (const [where, version] of Object.entries(found)) {
  if (!version) {
    console.error(`::error file=${where}::no version found in ${where}`);
    failed = true;
  }
}

const distinct = new Set(Object.values(found).filter(Boolean));
if (distinct.size > 1) {
  failed = true;
  console.error("::error::the version is not the same everywhere");
  for (const [where, version] of Object.entries(found)) {
    console.error(`  ${version ?? "(missing)"}  <-  ${where}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log(
  `ok - one version in all ${Object.keys(found).length} places: ${[...distinct][0]}`,
);
