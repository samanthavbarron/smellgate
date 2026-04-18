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
- `SMELLGATE_CURATOR_DIDS` — comma-separated DIDs of curator accounts. Production value: `did:plc:l6l3piyd3hywg76f2udorm53` (handle [`smellgate.bsky.social`](https://bsky.app/profile/smellgate.bsky.social)). A second curator DID for Sam will be appended once that account exists.
- `TAP_URL` — Tap consumer's HTTP endpoint. Prefer the internal `*.flycast` address if Tap runs as its own Fly app. **Not required for the first production deploy** — the app will come up healthy with an empty cache until Tap is hosted (see issue #148).
- `TAP_ADMIN_PASSWORD` — Tap webhook shared secret. Same note as `TAP_URL`.

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

**Deferred to [issue #148](https://github.com/samanthavbarron/smellgate/issues/148).** The first production deploy shipped here runs only the Next.js app; no firehose consumer is attached, so the read cache starts and stays empty until Tap is wired up. The Next.js webhook at `/api/webhook` is live and waiting.

When #148 is picked up, two reasonable shapes (unchanged from the original design):

1. **Separate Fly app** — `smellgate-tap` in the same org/region, with `TAP_URL` set to its internal `*.flycast` address so webhook traffic never leaves the Fly private network. Cleanest isolation, slightly more machines.
2. **Co-located process** — run Tap as a second process inside the same Fly machine via `fly.toml`'s multi-process support. Fewer machines, tighter coupling.

Pick whichever is cheaper at deploy time on Fly's current pricing. Both are reversible.

## Rollback story

- **Code rollback** is a single `flyctl releases rollback` — Fly keeps prior releases, and the SQLite database lives on the volume independent of the release, so reverting code does not touch cache state.
- **Database migrations** are a different story. Kysely migrations in `lib/db/migrations.ts` are forward-only today; a bad migration is not rolled back, it is patched forward. Until smellgate has real users whose data is worth protecting, avoid migrations that drop columns or destructively reshape tables — prefer additive changes that can be cleaned up in a later migration.
