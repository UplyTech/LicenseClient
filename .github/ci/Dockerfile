# One image with both toolchains, for the jobs that compare the two editions
# (parity, surface, packaging). Built on the runner, never pushed anywhere.
# Dependabot watches the FROM lines; the Node binary and npm are taken from the
# official Node image rather than installed from a script off the internet.
FROM node:20-bookworm-slim AS node
FROM python:3.12-slim
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
