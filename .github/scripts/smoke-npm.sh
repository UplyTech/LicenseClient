#!/usr/bin/env bash
#
# Install the packed tarball the way a caller would, and use it.
#
# Everything in the test suite imports from `src/`. That leaves the whole
# publishing surface untested: the `exports` map, the built files, the two
# module formats. This is the only place where the artefact is exercised
# instead of the source.
set -euo pipefail

temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
consumer="${temp}/consumer-npm"

rm -rf "${consumer}"
mkdir -p "${consumer}"
cd "${consumer}"

npm init -y > /dev/null
npm install --no-audit --no-fund "${temp}"/*.tgz

# require() - the CommonJS half of the exports map.
node -e '
  const pkg = require("@uplytech/license-client");
  const names = Object.keys(pkg);
  if (names.length === 0) {
    throw new Error("the package exports nothing");
  }
  const undefinedExports = names.filter((name) => pkg[name] === undefined);
  if (undefinedExports.length > 0) {
    throw new Error("exported as undefined: " + undefinedExports.join(", "));
  }
  console.log(`ok - cjs consumer, ${names.length} exports`);
'

# import - the ESM half.
node --input-type=module -e '
  import * as pkg from "@uplytech/license-client";
  const names = Object.keys(pkg);
  if (names.length === 0) {
    throw new Error("the package exports nothing");
  }
  const undefinedExports = names.filter((name) => pkg[name] === undefined);
  if (undefinedExports.length > 0) {
    throw new Error("exported as undefined: " + undefinedExports.join(", "));
  }
  console.log(`ok - esm consumer, ${names.length} exports`);
'
