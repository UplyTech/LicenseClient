#!/usr/bin/env node
/**
 * The code examples in the README import only names that really exist.
 *
 * `ci.yml` runs the files under `examples/`. The snippets *in* the README are
 * run by nobody - and those are what somebody tries first. An example that no
 * longer runs is the most expensive kind of documentation: it costs the reader
 * time first and trust second.
 *
 * What is checked is not the output but the part that is checkable without a
 * database and without a network: every name an example imports **from this
 * library** is one the library exports. That is exactly what a rename breaks,
 * and exactly what a read-through does not catch.
 *
 * Two things this deliberately does *not* do:
 *
 *   - Check imports from the standard library. `from collections.abc import
 *     Mapping` in an example is perfectly fine and none of this script's
 *     business. Only the package's own module counts.
 *   - Measure one edition against the other. Each edition is checked against
 *     its own export list. That is not a detail: the editions deliberately do
 *     not carry the same names everywhere - RankMode's `SystemRandomSource` is
 *     `CryptoRandomSource` in TypeScript, because each is the idiomatic word in
 *     its own language. A check that conflates them reports exactly the places
 *     that are right.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

/** The name of the Python module and of the npm package. */
const MODULE = JSON.parse(readFileSync(join(here, "docs-config.json"), "utf8"));

const FILES = ["README.md", "typescript/README.md", "python/README.md"];

/** Every fenced block in one of the given languages. */
function blocks(markdown, languages) {
  const found = [];
  let current = null;
  for (const line of markdown.split("\n")) {
    const fence = line.match(/^```([a-zA-Z]*)\s*$/);
    if (fence) {
      if (current === null) {
        current = languages.includes(fence[1].toLowerCase()) ? [] : undefined;
      } else {
        if (current !== undefined) found.push(current.join("\n"));
        current = null;
      }
      continue;
    }
    if (Array.isArray(current)) current.push(line);
  }
  return found;
}

/** `import { a, b as c } from "<module>"` - only when the module is ours. */
function typescriptImports(source) {
  const names = new Set();
  const pattern = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const from = match[2];
    const ours =
      from === MODULE.npm ||
      from.startsWith(`${MODULE.npm}/`) ||
      from.includes("/src/index") ||
      from.startsWith("../src");
    if (!ours) continue;
    for (const part of match[1].split(",")) {
      const name = part.split(/\s+as\s+/)[0].replace(/^type\s+/, "").trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** `from <module> import (a, b)` - only when the module is ours. */
function pythonImports(source) {
  const names = new Set();
  const pattern = new RegExp(
    String.raw`from\s+(${MODULE.python}[\w.]*)\s+import\s+(\(([^)]*)\)|([^\n#]+))`,
    "g",
  );
  for (const match of source.matchAll(pattern)) {
    const body = match[3] ?? match[4] ?? "";
    for (const part of body.split(",")) {
      const name = part.split(/\s+as\s+/)[0].trim();
      // A star import names nothing, and a trailing comment is not an
      // identifier.
      if (name && name !== "*" && /^[A-Za-z_]\w*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** What the TypeScript edition exports - from the built package. */
const typescriptEdition = await import(
  pathToFileURL(join(root, "typescript", "dist", "index.mjs")).href
);
const typescriptExports = new Set(Object.keys(typescriptEdition));

/**
 * What the Python edition exports - from its `__all__`.
 *
 * Asked of the interpreter rather than kept as a copy of the list: a copy would
 * be a second truth, and it would go stale exactly when it is needed.
 */
function pythonExports() {
  const python = process.env.PYTHON || "python";
  const code =
    `import json, ${MODULE.python} as m; ` +
    `print(json.dumps(sorted(getattr(m, "__all__", dir(m)))))`;
  const out = execFileSync(python, ["-c", code], {
    cwd: join(root, "python"),
    env: { ...process.env, PYTHONPATH: "src" },
    encoding: "utf8",
  });
  return new Set(JSON.parse(out));
}

const pythonNames = pythonExports();

let failed = false;
let checked = 0;
let blocksSeen = 0;

for (const file of FILES) {
  let markdown;
  try {
    markdown = readFileSync(join(root, ...file.split("/")), "utf8");
  } catch {
    continue;
  }

  for (const [languages, extract, exports, edition] of [
    [["typescript", "ts", "javascript", "js"], typescriptImports, typescriptExports, "TypeScript"],
    [["python", "py"], pythonImports, pythonNames, "Python"],
  ]) {
    for (const block of blocks(markdown, languages)) {
      blocksSeen += 1;
      for (const name of extract(block)) {
        checked += 1;
        if (!exports.has(name)) {
          console.error(
            `::error file=${file}::An example imports "${name}", which the ` +
              `${edition} edition does not export.`,
          );
          failed = true;
        }
      }
    }
  }
}

// A check that passes because it found nothing is the kind of green tick nobody
// looks behind.
if (blocksSeen === 0) {
  console.error("::error::Not a single code block found in the READMEs.");
  console.error("::error::Either they have no examples any more, or this script");
  console.error("::error::does not find them - both are worth knowing.");
  process.exit(1);
}
if (checked === 0) {
  console.error(
    `::error::${blocksSeen} code blocks found, but not one import from ` +
      `"${MODULE.python}" or "${MODULE.npm}".`,
  );
  process.exit(1);
}

if (failed) process.exit(1);

console.log(
  `ok - ${checked} imported names across ${blocksSeen} example blocks exist`,
);
