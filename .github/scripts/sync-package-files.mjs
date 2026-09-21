#!/usr/bin/env node
/**
 * Copy README.md, LICENSE and CHANGELOG.md from the root into both editions.
 *
 * There is one readme, one licence and one history for the whole project, but
 * every published artefact has to carry its own copy: `package.json` lists them
 * under "files", `pyproject.toml` names the readme outright, and the hatch sdist
 * includes all three. The copies are generated rather than maintained, and
 * `.gitignore` keeps them out of the repository so nobody can edit the copy
 * instead of the original.
 *
 * That makes this a build step, not a convenience: on a fresh clone the copies
 * do not exist, so a publish without it ships a package with no licence file -
 * or, for the wheel, does not build at all, because `readme = "README.md"`
 * names a file that is not there.
 *
 * README.md was not in this list until 2.0.0, and the two copies had drifted a
 * whole feature set apart: npm was serving a description of a client without
 * the update window, the seat methods or the retry policy. That is the failure
 * this script exists to make impossible, so it now covers the file it was
 * missing.
 *
 * With --check it only reports; that is what CI uses to prove the copies would
 * be correct without writing anything.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const check = process.argv.includes("--check");

const jobs = [];
for (const edition of ["python", "typescript"]) {
  for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) {
    jobs.push({
      from: join(root, file),
      to: join(root, edition, file),
      label: `${edition}/${file}`,
    });
  }
}

let stale = 0;
for (const { from, to, label } of jobs) {
  const source = readFileSync(from);
  const upToDate = existsSync(to) && readFileSync(to).equals(source);

  if (check) {
    if (!upToDate) {
      stale += 1;
      console.error(`::error::${label} is missing or differs from the root copy`);
    }
    continue;
  }

  if (upToDate) {
    console.log(`unchanged ${label}`);
  } else {
    copyFileSync(from, to);
    console.log(`wrote     ${label}`);
  }
}

if (check && stale > 0) {
  console.error("run `node .github/scripts/sync-package-files.mjs` to refresh them");
  process.exit(1);
}

if (check) {
  console.log("ok - both editions carry the current readme, licence and changelog");
}
