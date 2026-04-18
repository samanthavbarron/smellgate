# Deployment

smellgate is deployed to **Fly.io**. This document records the decision, the environment shape, and the deploy workflow.

## Why Fly.io

smellgate has three awkward constraints for a "modern" host:

- The Next.js app is a long-running Node process, not a bag of serverless functions. Fly runs containers as long-lived machines with no cold-boot / function-timeout weirdness to design around.
- The Tap consumer subscribes to the atproto firehose and POSTs record events to `/api/webhook`. It is a persistent subscriber, not a request/response handler. Fly is happy to run it either as a second app in the same org or as a co-located process inside the same machine via a multi-process `fly.toml`.
- The read cache is SQLite on disk. Fly volumes provide mounted durable storage, so we don't need to stand up Postgres just to get persistence.

As a bonus, every Fly app gets a public HTTPS URL at `https://<app>.fly.dev` for free, which is exactly what the hosted OAuth client metadata path (`/oauth-client-metadata.json`) needs.

**Explicitly rejected:**

- **Cloudflare Workers** — the Tap consumer does not fit the request/response execution model, and SQLite-on-disk isn't a thing on Workers. Non-starter.
- **Vercel serverless** — SQLite + a long-running firehose subscriber fights the platform the whole way.
- **Plain VM (Hetzner / DO droplet)** — too much hand-rolled ops for a v1 app with zero real users.

## Environment variables

Required in production:

- `PUBLIC_URL` — hosted app URL (e.g. `https://smellgate.fly.dev`, or the custom domain once DNS is configured).
- `PRIVATE_KEY` — ES256 JWK JSON string for OAuth client assertion signing. Generate locally with `pnpm gen-key`, then set as a Fly secret. Rotate only via redeploy; never set at runtime.
- `SMELLGATE_CURATOR_DIDS` — comma-separated DIDs of curator accounts. Production value: `did:plc:sna3qx44beg2mb5fao44gsxh` (handle [`samantha.wiki`](https://bsky.app/profile/samantha.wiki)) — stopgap while `@smellgate.bsky.social` credentials are being recovered; will swap back once that account is reachable. A second curator DID for Sam will be appended once that account exists.
- `TAP_URL` — internal URL of the `smellgate-tap` Fly app, used by `lib/db/queries.ts` `getAccountHandle` to resolve DIDs via `getTap().resolveDid(...)`. Production value is `http://smellgate-tap.flycast:2480` so traffic stays inside Fly's private network. See "Tap consumer hosting" below.
- `TAP_ADMIN_PASSWORD` — shared secret. indigo's upstream Tap binary gates three surfaces behind this single value by design — outbound webhook auth (Tap → main app), inbound admin API auth (main app → Tap for `resolveDid`), and `/repos/add` DID enrollment. Rotation is therefore atomic and a leak compromises all three. This is an upstream indigo constraint, not a smellgate choice. Must be set to a non-empty string in production: `instrumentation.ts` hard-fails on boot when `NODE_ENV=production` and the secret is empty or unset, so a mis-config surfaces as a failed deploy rather than a silently-unauthenticated webhook. Generate once with `openssl rand -hex 32` (see "Tap consumer hosting" for the one-shot setup) and set the same value on both apps.

Image-baked (set in the `Dockerfile`'s runner stage, not a Fly secret):

- `DATABASE_PATH=/data/smellgate.db` — path to the SQLite file on the mounted Fly volume. The value is a property of this image (the volume mount at `/data` is a contract between `fly.toml` and the `Dockerfile`), so it's `ENV`-baked rather than set via `flyctl secrets`. Don't set it as a secret; a stray override would silently point the app at a non-volume path.

Build-time:

- `GIT_COMMIT` — passed as a Docker `--build-arg` by `.github/workflows/deploy.yml` (value: `${{ github.sha }}`). Baked into the image as an env var so `GET /api/health` can surface the deployed revision.

Must stay **unset** in production:

- `SMELLGATE_DEV_HANDLE_RESOLVER` and `SMELLGATE_DEV_PLC_URL` — these are dev-only overrides consumed by `lib/auth/client.ts` to point at an ephemeral PDS in tests. In production they must remain unset so the real bsky.social / plc.directory is used.

Optional:

- `SMELLGATE_TAP_DEBUG=1` — enables dispatcher drop-site observability (see PR #96). Leave off in normal production operation; flip on temporarily when diagnosing missing webhook events.

## DNS

- `_lexicon.smellgate.app` TXT record, value `did=did:plc:l6l3piyd3hywg76f2udorm53`, was set and confirmed live (2026-04-17) via DNS-over-HTTPS. This declares the authority for `app.smellgate.*` lexicons. See [docs/lexicons.md](./lexicons.md) under "Lexicon authority publication".
- The first production deploy uses `smellgate.fly.dev` as `PUBLIC_URL`. Pointing a custom domain (e.g. `smellgate.app`) at Fly is a follow-up — once that's done, update `PUBLIC_URL` to the custom domain and redeploy. OAuth client metadata is keyed off `PUBLIC_URL`, so changing it mid-session will invalidate existing OAuth sessions until clients refresh.

## Deploy workflow

The GitHub Actions workflow at [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs `flyctl deploy --remote-only` on every push to `main`.

- **No preview deploys in v1.** The Phase 5 shape was deliberately kept to production-only: every merge to `main` triggers a production deploy. The cost of not being able to visually smoke-test a PR against a preview environment is low while the app is pre-launch, and the PR CI check (`lint / typecheck / test / build`) is already required by branch protection on `main`.
- The workflow uses Fly's official `superfly/flyctl-actions/setup-flyctl` action, pinned to a released tag (currently `@1.6`) to avoid supply-chain drift from `@master`.
- The workflow deliberately does NOT re-run the CI check — branch protection enforces it at merge time, so duplicating it here would just add latency and create a race.
- The workflow passes `--build-arg GIT_COMMIT=${{ github.sha }}` so the image bakes in the deployed revision; `/api/health` echoes it back.

Repository secrets required in GitHub Actions (on the `production` environment):

- `FLY_ACCESS_TOKEN` — a Fly deploy token scoped **to this app only**, not an org-wide token. Created via `fly tokens create deploy`. Current `flyctl` reads `FLY_ACCESS_TOKEN` natively; no mapping from the older `FLY_API_TOKEN` name is needed.

## First-time Fly setup (one-shot manual steps)

Before the workflow can deploy, the Fly app, volume, and secrets must exist, and the volume must be chowned so the non-root `node` process can write to it:

```sh
# 1. Create the app shell (skip `flyctl launch`'s auto-generated fly.toml —
#    we already have one committed; use `fly apps create` instead).
flyctl apps create smellgate

# 2. Persistent SQLite volume in the primary region.
flyctl volumes create smellgate_data --size 1 --region iad --app smellgate

# 3. Secrets the app needs at runtime. PRIVATE_KEY comes from `pnpm gen-key`.
flyctl secrets set --app smellgate \
  PUBLIC_URL=https://smellgate.fly.dev \
  PRIVATE_KEY="$(pnpm -s gen-key)" \
  SMELLGATE_CURATOR_DIDS=did:plc:l6l3piyd3hywg76f2udorm53
# Tap secrets (TAP_URL, TAP_ADMIN_PASSWORD) can wait until issue #148.

# 4. Trigger the first deploy by pushing a commit to main, OR run
#    `flyctl deploy --remote-only` once from a local checkout. The first
#    boot WILL fail on `instrumentation.ts` trying to open the SQLite DB
#    under /data, because Fly volumes are owned by root on fresh mount and
#    this image's CMD runs as the non-root `node` user. That's expected.

# 5. SSH in as root and hand ownership to `node`. Do this ONCE, after the
#    volume has first been mounted (step 4 attaches it; this chown sticks
#    across all future machine starts).
flyctl ssh console -C 'chown -R node:node /data' --app smellgate

# 6. Redeploy. `instrumentation.register()` runs migrations, `/api/health`
#    starts returning 200, and the app is live.
flyctl deploy --remote-only --app smellgate
```

After these run once, every subsequent merge to `main` deploys automatically.

Why not `USER root` in the Dockerfile? Running the app process as root would sidestep the chown dance but removes a cheap layer of defense against an exploit in the Next.js server escaping to the filesystem. One-shot documented manual step was the narrow tradeoff picked for v1.

## Tap consumer hosting

The firehose consumer runs as a **separate Fly app** named `smellgate-tap`, configured via [`tap/fly.toml`](../tap/fly.toml) and [`tap/Dockerfile`](../tap/Dockerfile). Deploys are driven by [`.github/workflows/deploy-tap.yml`](../.github/workflows/deploy-tap.yml), which triggers on pushes to `main` that touch `tap/**`.

### What's running

The image is a single-line `FROM ghcr.io/bluesky-social/indigo/tap:<pinned-tag>` pulling the upstream Bluesky Tap Go binary. Tap handles everything:

- Firehose WebSocket + CBOR decoding
- Cryptographic verification, identity caching, backfill on repo discovery
- Cursor persistence to SQLite at `/data/tap.db` (on a Fly volume, survives machine restart)
- Collection filtering to `app.smellgate.*` — records outside our NSID space never reach our webhook
- Signal-collection discovery on `app.smellgate.shelfItem` — any repo that writes a shelf item gets added to tracking automatically; plus the curator DID added manually so its `perfume` records flow regardless
- Webhook delivery to the URL in `TAP_WEBHOOK_URL` (MUST include the `/api/webhook` path — Tap POSTs to the URL verbatim and does NOT append any path; see Gotchas below) with `Authorization: Basic admin:<password>` (at-least-once; Tap retries on non-2xx)

No custom TypeScript consumer was written. An earlier design sketch had the consumer be a TS wrapper around `@atproto/tap`, but that npm package is a client for a running Tap server — it doesn't subscribe to the firehose itself. A wrapper would have been a forwarder between Tap and our webhook, and Tap already supports direct webhook delivery via `TAP_WEBHOOK_URL`. Skipping the TS layer avoided a meaningful chunk of code with no benefit.

### Why shape (1) "Separate Fly app" instead of (2) "Co-located process"

- Crash isolation. A Tap OOM or firehose disconnect loop doesn't take down the user-facing Next.js app. With multi-process `fly.toml` they share a machine's memory budget and restart lifecycle.
- Independent scaling. Tap holds the identity cache and cursor DB; the Next.js app is stateless-ish (SQLite cache can be rebuilt). They scale on different signals.
- Simpler secrets. Tap needs `TAP_WEBHOOK_URL` (the main app's public URL) and `TAP_ADMIN_PASSWORD`. The main app needs `TAP_URL` (Tap's flycast URL) and the same `TAP_ADMIN_PASSWORD`. Splitting the apps makes "which secret lives where" obvious; co-located, both services would see both envs and it's easier to grow a cross-coupling.
- Cost. Each app is `shared-cpu-1x` / 512MB = within Fly's free allowance for two machines. The overhead is negligible.

### One-time Fly setup for smellgate-tap

Run once, from a machine with `flyctl` logged in to the Fly org hosting `smellgate`:

```sh
# 1. Create the app shell. Same org/region as the main app.
flyctl apps create smellgate-tap

# 2. Persistent volume for Tap's cursor + identity cache.
#    1GB is Fly's minimum and is more than enough for a small deployment.
flyctl volumes create tap_data --size 1 --region iad --app smellgate-tap

# 3. Generate the shared secret ONCE. Same byte-for-byte value on both apps.
#    `openssl rand -hex 32` gives 64 hex chars; any length works for Basic auth.
TAP_ADMIN_PASSWORD=$(openssl rand -hex 32)

# 4. Set secrets on smellgate-tap (where to POST events, and the shared
#    secret to sign those POSTs with).
flyctl secrets set --app smellgate-tap \
  TAP_WEBHOOK_URL=https://smellgate.fly.dev/api/webhook \
  TAP_ADMIN_PASSWORD="$TAP_ADMIN_PASSWORD"

# 5. Set matching secrets on the main smellgate app so (a) its
#    `getTap().resolveDid(...)` calls can reach Tap over flycast, and
#    (b) its `/api/webhook` route verifies incoming POSTs against the
#    same shared secret.
flyctl secrets set --app smellgate \
  TAP_URL=http://smellgate-tap.flycast:2480 \
  TAP_ADMIN_PASSWORD="$TAP_ADMIN_PASSWORD"

# 6. First deploy of smellgate-tap. Either push a commit that touches
#    `tap/**` and let the workflow run, or run locally:
flyctl deploy --remote-only --config tap/fly.toml

# 7. Seed Tap with the curator DID so `app.smellgate.perfume` records
#    flow from day one (the signal-collection discovery only triggers
#    on `app.smellgate.shelfItem`, and the curator doesn't write those).
#    smellgate-tap's fly.toml deliberately does NOT expose a public HTTP
#    listener (the `services.ports` block has `handlers = []`), so the
#    seed call goes over a Fly wireguard proxy rather than the public
#    *.fly.dev hostname. The helper script handles that:
tap/seed-curator.sh did:plc:l6l3piyd3hywg76f2udorm53
```

After step 6 plus step 7 run, every subsequent merge to `main` that touches `tap/**` deploys automatically. Every merge that touches anything else deploys only the main `smellgate` app.

### Post-deploy sanity checks

```sh
# 1. How many repos is Tap subscribed to? Expect "1" right after step 7
#    (the curator); grows as users write `app.smellgate.shelfItem`
#    records and the signal-collection crawler picks them up.
flyctl proxy 2480 -a smellgate-tap &
sleep 2
curl -s -u "admin:$TAP_ADMIN_PASSWORD" http://localhost:2480/stats/repo-count
pkill -f "flyctl proxy 2480"

# 2. Is the webhook flowing? Watch for `webhook: delivered` in Tap's
#    logs as the curator's perfume records backfill, and matching 200s
#    on /api/webhook in the main app's logs.
flyctl logs --app smellgate-tap
flyctl logs --app smellgate

# 3. Verify the webhook URL actually includes the /api/webhook path.
#    The #211 failure mode: if TAP_WEBHOOK_URL was set to just the
#    host (e.g. https://smellgate.fly.dev) without the path, Tap POSTs
#    to the Next.js home page, which returns HTTP 200 (a normal page
#    render). Tap interprets 200 as "delivered", acks the event,
#    deletes it from outbox_buffers, and no record ever reaches
#    /api/webhook. Silent data loss. To confirm the secret is correct:
flyctl ssh console -a smellgate-tap -C 'env' | grep TAP_WEBHOOK_URL
# Expected: TAP_WEBHOOK_URL=https://smellgate.fly.dev/api/webhook
# If the path is missing, re-run step 4 from the one-time setup above.
```

### Gotchas

- **`TAP_WEBHOOK_URL` must include the `/api/webhook` path.** Indigo's Tap binary (see `webhook_client.go` in `cmd/tap`) POSTs to the URL *verbatim* — it does not append any route. Setting the secret to `https://smellgate.fly.dev` (bare host) will cause Tap to POST to `/`, Next.js will return HTTP 200 rendering the home page, Tap will treat that as delivery success, and events will be silently acked and dropped. The receiving app never sees them. This was issue #211. Always set the full URL including path: `TAP_WEBHOOK_URL=https://smellgate.fly.dev/api/webhook`.

### Fly access token scope

The `FLY_ACCESS_TOKEN` GitHub Actions secret (on the `production` environment) must grant deploy permission on **both** apps. Use an **org-scoped deploy token**: one token, works for any current or future app in the org, and the blast radius of a leak is bounded by the GitHub Actions environment secret scoping anyway.

```sh
flyctl tokens create org <your-org>
# Paste the output into the GitHub repo's `production` environment secret FLY_ACCESS_TOKEN.
```

If the existing token was created with `flyctl tokens create deploy` before `smellgate-tap` existed, it's app-scoped to `smellgate` only and the Tap deploy workflow will fail with an auth error on first run. Rotate to an org-scoped token (command above) before merging the first PR that touches `tap/**`. There's a hacky comma-delimited per-app-token form flyctl also accepts; don't use it for this — the org-scoped token is the right answer.

### End-to-end verification

After the Tap app is deployed and the curator DID has been added (step 7 above):

1. `flyctl logs --app smellgate-tap` — watch for `webhook: delivered` lines once events start arriving. Backfill on the curator repo takes a few seconds; subsequent live events appear within firehose latency (~sub-second).
2. `flyctl logs --app smellgate` — watch `/api/webhook` POST 200s. If you see 401s, the shared secret is mismatched between apps. If you see 500s, the dispatcher is throwing (turn on `SMELLGATE_TAP_DEBUG=1` on the main app temporarily).
3. From any Bluesky account, write a `app.smellgate.description` record for an existing canonical perfume (via `pnpm agent:as` locally or the UI composer once Tap is live in front of the production app). Within seconds, `curl https://smellgate.fly.dev/perfume/<at-uri>` should render the new description.

If step 3 fails, the drop-reason is almost always one of: (a) record didn't validate against the generated lexicon (check with `pnpm build:lex && node -e ...`), (b) the `SMELLGATE_CURATOR_DIDS` list on the main app doesn't include the author DID for curator-only record types, (c) the `TAP_ADMIN_PASSWORD` values on the two apps disagree. Turn on `SMELLGATE_TAP_DEBUG=1` via `flyctl secrets set` on the main app to surface drop reasons.

## Rollback story

- **Code rollback** is a single `flyctl releases rollback` — Fly keeps prior releases, and the SQLite database lives on the volume independent of the release, so reverting code does not touch cache state.
- **Database migrations** are a different story. Kysely migrations in `lib/db/migrations.ts` are forward-only today; a bad migration is not rolled back, it is patched forward. Until smellgate has real users whose data is worth protecting, avoid migrations that drop columns or destructively reshape tables — prefer additive changes that can be cleaned up in a later migration.
