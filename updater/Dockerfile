# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# The opt-in updater (compose profile `updater`, docs/operations.md "Updater"): a small Node service with the docker CLI +
# compose plugin and cosign. It never mounts the Docker socket: it talks to the socket proxy (DOCKER_HOST=tcp://docker-proxy:2375).
FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json backend/
COPY gateway/package.json gateway/
COPY web/package.json web/
COPY updater/package.json updater/
RUN npm ci
COPY updater updater
RUN npm run build -w updater

FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a
ARG GIT_SHA=dev
ARG BUILD_TIME=
ARG APP_VERSION=
ARG APP_CODENAME=
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME APP_VERSION=$APP_VERSION APP_CODENAME=$APP_CODENAME
# read-only root fs: every tool writes below /tmp (tmpfs in compose); the state volume is /state
ENV NODE_ENV=production HOME=/tmp DOCKER_CONFIG=/tmp/.docker
WORKDIR /app
# Alpine packages: same ruling as the other images (no blanket `apk upgrade`, minimum versions only for fixes the base lacks;
# docs/reproducible-builds.md). docker-cli + docker-cli-compose run `compose pull/up` against the proxy, cosign verifies
# the signatures. Not version-pinned (pins vanish from the Alpine mirrors): reproducible while Alpine has not shipped newer ones.
RUN apk add --no-cache 'zlib>=1.3.2-r1' docker-cli docker-cli-compose cosign \
  && rm -rf /var/log/apk.log /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && mkdir -p /state && chown node:node /state
COPY --from=build --chown=node:node /app/updater/dist updater/dist
COPY --chown=node:node updater/package.json updater/
USER node
EXPOSE 7070
VOLUME ["/state"]
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:7070/healthz || exit 1
CMD ["node", "updater/dist/server.js"]
