# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the smellgate Next.js app on Fly.io.
#
# Layout:
#   deps    — install all workspace deps via pnpm (needs devDeps for the build)
#   build   — run `pnpm build:lex` + `next build` to produce `.next/standalone`
#   runner  — minimal runtime: Next.js standalone server on port 3000
#
# Notes:
# - `package.json` pins `engines.node: ">=24"`. We use Node 24 on Alpine.
# - `better-sqlite3` ships its own native binding. We do NOT `apk add sqlite`
#   or `sqlite-dev`; the binary is resolved from the `better-sqlite3` package.
#   Building it from source would need `python3 make g++`, but upstream ships
#   prebuilt binaries for Node 24 on linux-x64 (and arm64), so we skip the
#   build toolchain and accept a build failure if prebuilt resolution ever
#   fails — loud failure is better than a silent toolchain.
# - `pnpm build:lex` must run during the image build because `lib/lexicons/`
#   is gitignored (see `.gitignore`). Without it, `next build` fails on
#   missing TS modules.
# - The standalone output is Next.js's recommended deploy shape. It bundles
#   a minimal `node_modules` tree into `.next/standalone/node_modules`, so
#   the runner stage does NOT need a separate `pnpm install --prod`.

ARG NODE_VERSION=24-alpine
ARG PNPM_VERSION=8.15.9

# ---------------------------------------------------------------------------
# Stage 1: deps — full dependency install (includes devDeps for the build)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# Enable pnpm via corepack, pinned to the version declared in package.json's
# `packageManager` field so local dev and CI match this image.
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
ARG PNPM_VERSION

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: build — generate lexicon TS and produce `.next/standalone`
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
ARG PNPM_VERSION

# Bring over installed deps from the `deps` stage, then overlay the source.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `pnpm build` is `pnpm build:lex && next build`. build:lex regenerates the
# gitignored lib/lexicons TS so `next build` can import them.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---------------------------------------------------------------------------
# Stage 3: runner — minimal Next.js standalone server
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

# Build-arg threaded through from `flyctl deploy --build-arg GIT_COMMIT=...`.
# Surfaced by /api/health so the deployed revision is legible at runtime.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Fly volume mount point (see fly.toml's [[mounts]] block). The SQLite file
# and any future durable state lives here.
ENV DATABASE_PATH=/data/smellgate.db
RUN mkdir -p /data && chown -R node:node /data

# Next.js standalone output. The `server.js` entrypoint lives at the root of
# .next/standalone; `.next/static` and `public` must be mounted alongside.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000

CMD ["node", "server.js"]
