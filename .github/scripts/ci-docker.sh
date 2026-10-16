#!/usr/bin/env bash
#
# Run a script, read from stdin, inside a pinned tool image.
#
# The own runner has docker and nothing else that a build needs: no node, no
# python. The work tree is bind-mounted at the same path as on the host, so
# files written here (coverage reports, packed tarballs under .ci-tmp) are
# visible to the next step.
#
# usage: ci-docker.sh IMAGE [WORKDIR] <<'SH' ... SH
set -euo pipefail

image="${1:?usage: ci-docker.sh IMAGE [WORKDIR]}"
workdir="${2:-.}"

mkdir -p "${PWD}/.ci-tmp"

exec docker run --rm -i \
  -v "${PWD}:${PWD}" \
  -w "${PWD}/${workdir}" \
  -e HOME=/tmp \
  -e CI=true \
  -e RUNNER_TEMP="${PWD}/.ci-tmp" \
  -e NPM_CONFIG_FUND=false \
  -e NPM_CONFIG_AUDIT=false \
  -e NPM_CONFIG_CACHE=/tmp/npm-cache \
  -e PIP_ROOT_USER_ACTION=ignore \
  -e PIP_DISABLE_PIP_VERSION_CHECK=1 \
  -e PIP_CACHE_DIR=/tmp/pip-cache \
  -e PYTHON=python \
  "${image}" bash -euo pipefail -s
