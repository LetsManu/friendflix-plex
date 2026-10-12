# syntax=docker/dockerfile:1
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json backend/
COPY gateway/package.json gateway/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm run build -w web

FROM node:26-alpine
ARG GIT_SHA=dev
ARG BUILD_TIME=
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
# Runtime needs only node; the npm/yarn bundled in the base image only adds CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build --chown=node:node /app/web/build build
COPY --chown=node:node web/package.json package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "build"]
