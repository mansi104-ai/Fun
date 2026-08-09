# syntax=docker/dockerfile:1

# ── Build ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# better-sqlite3 compiles from source when no prebuild matches the platform.
RUN apk add --no-cache python3 make g++ && corepack enable

COPY server/package.json server/
COPY package.json pnpm-workspace.yaml ./

# Scripts run during install, not via a later `pnpm rebuild`. The allowlist in
# pnpm-workspace.yaml (onlyBuiltDependencies) is what permits it, and it is
# narrow on purpose.
#
# The previous `--ignore-scripts` + `pnpm rebuild better-sqlite3` combination
# looked equivalent and was not: rebuild exited 0 while compiling nothing, so
# the image built green and then failed at boot with a missing
# better_sqlite3.node. Verified by finding the binding present in the build
# stage before trusting it.
RUN cd server && pnpm install --prod=false

COPY server/tsconfig.json server/
COPY server/src server/src
RUN cd server && pnpm exec tsc -p tsconfig.json
RUN test -f "$(find /app -name better_sqlite3.node | head -1)" \
    || (echo "FATAL: better-sqlite3 native binding was not built" && exit 1)

# ── Runtime ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runs unprivileged. The data directory is the only writable path it needs.
RUN addgroup -S app && adduser -S app -G app

# BOTH node_modules trees are required, and the order of these two lines is not
# arbitrary.
#
# pnpm stores every real package once under the workspace root at
# /app/node_modules/.pnpm, and fills /app/server/node_modules with RELATIVE
# symlinks into it (fastify -> ../../node_modules/.pnpm/fastify@5/...). Copying
# only the server tree carries the links and leaves their targets behind: the
# image builds perfectly clean and then dies at boot with ERR_MODULE_NOT_FOUND.
# Copying both preserves the relative structure the links were written against.
#
# `ls /app/node_modules | wc -l` reports 0 for the root tree, because .pnpm is a
# dotfile. It is not empty — do not "optimise" this line away.
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/server/node_modules ./server/node_modules
COPY --from=build --chown=app:app /app/server/dist ./server/dist
COPY --from=build --chown=app:app /app/server/package.json ./server/package.json
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --chown=app:app web ./web

# SQLite lives on a mounted volume so data survives redeploys. Swap for
# Postgres before public launch — see docs/05 §2.
RUN mkdir -p /data && chown app:app /data
ENV DATABASE_PATH=/data/mailwarden.db
VOLUME ["/data"]

USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
