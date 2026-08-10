# IRIS staging/production image (issue #192).
#
# Based on the Playwright image rather than a bare node image, because IRIS
# drives a real Chromium: this ships the browser *and* its system libraries
# already. A `node:24` base would need `playwright install --with-deps` at build
# time — a ~400 MB download plus apt packages, and root to install them.
#
# The tag tracks the `playwright` version in package.json. Keep them in step: the
# library and the bundled browsers are matched pairs, and a drift between them
# fails in ways that look like application bugs.
#
# Verified to ship Node v24.18.1 / npm 11.16.0, satisfying
# "engines": { "node": "^22.13.0 || >=24" }.

# --- deps -------------------------------------------------------------------
# Production dependencies only, compiled. Separate from `build` so the compiler
# toolchain never reaches the shipped image: better-sqlite3 has no prebuilt
# binary for this platform and needs node-gyp, which the Playwright base image
# has no `make` for.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS deps

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# --ignore-scripts, then rebuild the one module that actually needs compiling.
# Running the full lifecycle here fails: package.json has
# `"prepare": "npm run build"`, and `--omit=dev` has just removed TypeScript, so
# prepare exits 127 before any native module is touched.
#
# The resulting .node is ABI-tied to the Node in this image — the same image the
# runtime stage uses, so the binary stays valid when copied across.
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild better-sqlite3 \
    && npm cache clean --force

# --- build ------------------------------------------------------------------
# Full dependency tree (TypeScript et al.) purely to produce dist/.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS build

WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: this stage only runs tsc, so paying for a native rebuild and
# a second browser download here would be waste.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/healthcheck.js ./docker/healthcheck.js

# `pwuser` (uid 1001) ships with the base image and owns the browser cache.
# Running as root would be gratuitous for a process that only serves a socket.
USER pwuser

# Documentation only — the published port is decided by compose, not here.
EXPOSE 4000

# 0.0.0.0 is required *inside* a container: Docker forwards a published port to
# the container's network interface, so a loopback bind would refuse every
# connection. The boundary is the host-side mapping (127.0.0.1:4000 in
# docker-compose.staging.yml), not this bind address.
ENV IRIS_CONNECT_HOST=0.0.0.0

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["connect", "4000"]
