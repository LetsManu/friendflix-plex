# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json backend/
COPY gateway/package.json gateway/
COPY web/package.json web/
COPY updater/package.json updater/
RUN npm ci
# the footer shows version.json; the codename list is shared with backend + release script
COPY version.json codenames.json ./
COPY web web
# SvelteKit's version.name (service worker cache, _app/version.json) = git sha, else SOURCE_DATE_EPOCH - never the
# build clock (web/src/lib/version/kit-version.ts), so a rebuild of the same commit is byte-identical
ARG GIT_SHA=dev
ARG SOURCE_DATE_EPOCH
RUN npm run build -w web

FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a
ARG GIT_SHA=dev
ARG BUILD_TIME=
# release version + codename from version.json (CI passes them as build args; empty = the app reads version.json)
ARG APP_VERSION=
ARG APP_CODENAME=
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME APP_VERSION=$APP_VERSION APP_CODENAME=$APP_CODENAME
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
# Runtime needs only node; the npm/yarn bundled in the base image only adds CVEs.
# Alpine packages (reproducible builds, ruling in docs/reproducible-builds.md): no blanket `apk upgrade` - it installs
# whatever the mirror has today, so the same commit built a week later differs. Packages come from the digest-pinned base
# image (Dependabot bumps it); only a security fix the base does not have yet is pulled in, as a minimum version
# (zlib 1.3.2-r1: CVE-2026-85091). `>=` and not `=`: Alpine drops superseded versions from its mirrors, an exact pin
# would break every build (and every rebuild of an old tag) at the next bump. Once the base image ships the fixed
# version this line is a no-op; remove the package from it then.
RUN apk add --no-cache 'zlib>=1.3.2-r1' && rm -rf /var/log/apk.log /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build --chown=node:node /app/web/build build
COPY --chown=node:node web/package.json package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "build"]
