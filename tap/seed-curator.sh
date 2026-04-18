#!/usr/bin/env bash
#
# tap/seed-curator.sh — enroll a DID in smellgate-tap's tracked repo set.
#
# Why this script exists:
#
#   smellgate-tap runs with TAP_SIGNAL_COLLECTION=app.smellgate.shelfItem,
#   which auto-discovers repos that have at least one shelfItem record.
#   The curator account writes `app.smellgate.perfume` records but no
#   shelf items, so the signal-collection crawler never picks it up.
#   The canonical catalog therefore has to be seeded explicitly via
#   Tap's POST /repos/add admin endpoint.
#
#   That endpoint is NOT exposed publicly — tap/fly.toml's services
#   block has handlers=[]. This script drives a `flyctl proxy` tunnel
#   to the private flycast :2480 and issues the curl for the operator.
#
# Usage:
#   TAP_ADMIN_PASSWORD=<secret> tap/seed-curator.sh <did>
#
#   <did>  A PLC or web DID to enroll, e.g.
#          did:plc:l6l3piyd3hywg76f2udorm53  (smellgate.bsky.social)
#
# Requirements:
#   - flyctl on PATH, logged in to the Fly org hosting smellgate-tap.
#   - curl.
#   - TAP_ADMIN_PASSWORD in the environment, matching the value set
#     on the smellgate-tap app via `flyctl secrets set`. We cannot
#     read it back from Fly (`flyctl secrets list` returns digests
#     only, not plaintext), so the operator must provide it.
#
# On exit the script kills the proxy subprocess it started. If anything
# goes wrong mid-flight a stray `flyctl proxy 2480` may linger; kill
# it with `pkill -f 'flyctl proxy 2480'`.
#
# Idempotent: POSTing the same DID twice is a no-op on Tap's side.

set -euo pipefail

if [ "${1-}" = "-h" ] || [ "${1-}" = "--help" ] || [ $# -lt 1 ]; then
  echo "usage: TAP_ADMIN_PASSWORD=<secret> $0 <did>" >&2
  echo "example: TAP_ADMIN_PASSWORD=... $0 did:plc:l6l3piyd3hywg76f2udorm53" >&2
  exit 2
fi

DID="$1"

if [ -z "${TAP_ADMIN_PASSWORD-}" ]; then
  echo "error: TAP_ADMIN_PASSWORD must be set in the environment" >&2
  echo "hint: retrieve it from your local record / password manager; it" >&2
  echo "      cannot be read back from 'flyctl secrets list'." >&2
  exit 2
fi

case "$DID" in
  did:plc:*|did:web:*) ;;
  *)
    echo "error: '$DID' does not look like a valid DID (did:plc:... or did:web:...)" >&2
    exit 2
    ;;
esac

# Bring up the proxy in the background. Use `&` + a trap so the proxy
# is always torn down on exit, even on curl failure.
echo "starting flyctl proxy 2480 -> smellgate-tap:2480..." >&2
flyctl proxy 2480 -a smellgate-tap &
PROXY_PID=$!
# Give the proxy a moment to bind. `flyctl proxy` prints its own
# readiness line; we sleep rather than parse stdout because the
# parsing would add fragility for no real win.
sleep 3

cleanup() {
  if kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "enrolling $DID..." >&2
# `-sS` = silent but show errors; `--fail-with-body` so a non-2xx
# response prints the server's error body AND exits non-zero.
curl -sS --fail-with-body \
  -u "admin:$TAP_ADMIN_PASSWORD" \
  -X POST http://localhost:2480/repos/add \
  -H "Content-Type: application/json" \
  -d "{\"dids\": [\"$DID\"]}"
RC=$?

# Tap returns an empty 200 on success; surface that clearly.
if [ $RC -eq 0 ]; then
  echo "OK: $DID enrolled. Backfill will begin shortly." >&2
  echo "     Verify with:" >&2
  echo "     curl -s -u admin:\$TAP_ADMIN_PASSWORD http://localhost:2480/stats/repo-count" >&2
fi

exit $RC
