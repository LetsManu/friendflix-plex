# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json backend/
COPY gateway/package.json gateway/
COPY web/package.json web/
RUN npm ci
COPY backend backend
RUN npm run build -w backend

FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY gateway/package.json gateway/
COPY web/package.json web/
RUN npm ci --omit=dev -w backend

FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a
ARG GIT_SHA=dev
ARG BUILD_TIME=
# release version + codename from version.json (CI passes them as build args; empty = the app reads version.json)
ARG APP_VERSION=
ARG APP_CODENAME=
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME APP_VERSION=$APP_VERSION APP_CODENAME=$APP_CODENAME
ENV NODE_ENV=production
WORKDIR /app
# Runtime needs only node; the npm/yarn bundled in the base image only adds CVEs.
# Alpine packages (reproducible builds, ruling in docs/reproducible-builds.md): no blanket `apk upgrade` - it installs
# whatever the mirror has today, so the same commit built a week later differs. Packages come from the digest-pinned base
# image (Dependabot bumps it); only a security fix the base does not have yet is pulled in, as a minimum version
# (zlib 1.3.2-r1: CVE-2026-85091). `>=` and not `=`: Alpine drops superseded versions from its mirrors, an exact pin
# would break every build (and every rebuild of an old tag) at the next bump. Once the base image ships the fixed
# version this line is a no-op; remove the package from it then.
RUN apk add --no-cache 'zlib>=1.3.2-r1' && rm -rf /var/log/apk.log /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/backend/dist backend/dist
COPY --chown=node:node backend/package.json backend/
COPY --chown=node:node version.json ./
# ffmpeg: remuxes prepared offline downloads (HLS fMP4 -> faststart MP4, stream copy only). Not version-pinned on purpose
# (pins vanish from the Alpine mirrors, see above): reproducible as long as Alpine v3.x has not shipped a newer ffmpeg or
# dependency since the build. No font package is installed, so the fontconfig trigger writes no (mtime-bearing) cache;
# the rm keeps it that way should a dependency ever pull fonts in.
RUN apk add --no-cache ffmpeg && rm -rf /var/log/apk.log /var/cache/fontconfig/* && mkdir -p /data/previews /data/downloads && chown node:node /data/previews /data/downloads
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "backend/dist/server.js"]
