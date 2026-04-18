# syntax=docker/dockerfile:1.7
#
# smellgate-tap: the firehose consumer that feeds /api/webhook on the main
# smellgate Next.js app.
#
# This image is a thin wrapper around the upstream Tap Go binary published
# at ghcr.io/bluesky-social/indigo/tap. Tap handles:
#   - Firehose websocket connection + CBOR decoding
#   - Cryptographic verification of repo state
#   - Identity resolution caching
#   - Backfill on newly-discovered repos
#   - Cursor persistence (to a SQLite DB under its WORKDIR)
#   - Filtering by DID / by collection NSID
#   - Webhook delivery with at-least-once semantics (retry on non-2xx)
#
# Why not a TypeScript consumer wrapping @atproto/tap?
#
# @atproto/tap (the npm package) is a client library that talks to a
# running Tap Go server over a WebSocket channel or validates Tap's
# webhook payloads. It does NOT subscribe to the firehose itself. The
# firehose decoding lives in the Go binary. Any TS wrapper we write
# would be a forwarder between Tap and the main app's webhook — and
# Tap already supports direct webhook delivery via TAP_WEBHOOK_URL.
# That makes the TS layer pure ceremony, so we skip it.
#
# The image tag is pinned to a specific release rather than :latest so
# that rebuilds are deterministic. Bump deliberately when upstream
# ships something worth adopting:
#   https://github.com/bluesky-social/indigo/pkgs/container/indigo%2Ftap
#
# The upstream image:
#   - runs as root (no USER in its Dockerfile; see config blob for 0.1.10)
#   - has WORKDIR /data, which is where Tap writes tap.db when
#     TAP_DATABASE_URL is left as the default
#   - binds :2480 for HTTP (/health, /channel, /repos/add, /resolve/:did)
#   - ENTRYPOINT=["dumb-init", "--"], CMD=["/tap", "run"]
#
# We override nothing and configure Tap entirely via env vars threaded
# in through fly.toml [env] (non-secret) and `flyctl secrets set`
# (secret). Keeping the Dockerfile a single FROM line means a Tap
# image bump is a one-line change here.

FROM ghcr.io/bluesky-social/indigo/tap:0.1.10
