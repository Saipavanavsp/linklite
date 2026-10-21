# syntax=docker/dockerfile:1

# ---- deps: install production dependencies only ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships a prebuilt binary for alpine (linuxmusl). npm 10 in
# this image doesn't read "allowScripts" from package.json and would try to
# compile it with node-gyp, so install scripts are skipped here instead.
# None of the production dependencies need one.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# better-sqlite3 also carries its C sources and binaries for 8 platforms.
# Keep only the one this image runs on (~25MB smaller).
RUN cd node_modules/better-sqlite3 \
 && rm -rf deps src binding.gyp \
 && arch="$(node -p process.arch)" \
 && find prebuilds -type f ! -name "linuxmusl-${arch}.node" -delete

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts/migrate.js ./scripts/migrate.js

# only needed when running with DB_DRIVER=sqlite
RUN mkdir -p /app/data && chown node:node /app/data

# the official image already has an unprivileged "node" user
USER node

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:3000/healthz || exit 1

# run node directly (not through npm) so it receives SIGTERM itself
CMD ["node", "src/server.js"]
