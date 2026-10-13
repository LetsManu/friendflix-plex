# syntax=docker/dockerfile:1
FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json backend/
COPY gateway/package.json gateway/
COPY web/package.json web/
RUN npm ci
COPY gateway gateway
RUN npm run build -w gateway

FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a
ARG GIT_SHA=dev
ARG BUILD_TIME=
# release version + codename from version.json (CI passes them as build args; empty = the app reads version.json)
ARG APP_VERSION=
ARG APP_CODENAME=
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME APP_VERSION=$APP_VERSION APP_CODENAME=$APP_CODENAME
ENV NODE_ENV=production
WORKDIR /app
# Runtime needs only node; the npm/yarn bundled in the base image only adds CVEs. apk upgrade pulls Alpine security fixes
# (e.g. zlib) that are newer than the pinned base image.
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build --chown=node:node /app/gateway/dist gateway/dist
COPY --chown=node:node gateway/package.json gateway/
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "gateway/dist/server.js"]
