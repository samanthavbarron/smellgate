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
- `DATABASE_PATH` — path to the SQLite file on a mounted Fly volume, e.g. `/data/smellgate.db`.
- `SMELLGATE_CURATOR_DIDS` — comma-separated DIDs of curator accounts. Initially unset (or a placeholder) until the curator account from #1 exists.
- `TAP_URL` — Tap consumer's HTTP endpoint. Prefer the internal `*.flycast` address if Tap runs as its own Fly app.
- `TAP_ADMIN_PASSWORD` — Tap webhook shared secret.

Must stay **unset** in production:

- `SMELLGATE_DEV_HANDLE_RESOLVER` and `SMELLGATE_DEV_PLC_URL` — these are dev-only overrides consumed by `lib/auth/client.ts` to point at an ephemeral PDS in tests. In production they must remain unset so the real bsky.social / plc.directory is used.

Optional:

- `SMELLGATE_TAP_DEBUG=1` — enables dispatcher drop-site observability (see PR #96). Leave off in normal production operation; flip on temporarily when diagnosing missing webhook events.

## DNS

- `_lexicon.smellgate.com` TXT record, value `did=<curator DID>`, is required before publishing any canonical `com.smellgate.*` lexicons. See [docs/lexicons.md](./lexicons.md) under "Lexicon authority publication" and issue #102.
- Once a custom apex (e.g. `smellgate.com`) is pointed at Fly, update `PUBLIC_URL` to the custom domain and redeploy. OAuth client metadata is keyed off `PUBLIC_URL`, so changing it mid-session will invalidate existing OAuth sessions until clients refresh.

## Deploy workflow

A GitHub Actions workflow at `.github/workflows/deploy.yml` (not yet committed — tracked as issue #103) will:

- Deploy previews on every pull request to a preview app, e.g. `smellgate-pr-<n>.fly.dev`.
- Deploy production on every merge to `main`, gated on the existing `lint / typecheck / test / build` check (never bypass branch protection).
- Use `superfly/flyctl-actions/setup-flyctl@master` (Fly's official GitHub Action).

Repository secrets required in GitHub Actions:

- `FLY_API_TOKEN` — a Fly deploy token scoped **to this app only**, not an org-wide token.

## Tap consumer hosting

Tap subscribes to the atproto firehose and POSTs record events to `/api/webhook` on the Next.js app. On Fly there are two reasonable shapes:

1. **Separate Fly app** — `smellgate-tap` in the same org/region, with `TAP_URL` set to its internal `*.flycast` address so webhook traffic never leaves the Fly private network. Cleanest isolation, slightly more machines.
2. **Co-located process** — run Tap as a second process inside the same Fly machine via `fly.toml`'s multi-process support. Fewer machines, tighter coupling.

Pick whichever is cheaper at deploy time on Fly's current pricing. Both are reversible.

## Rollback story

- **Code rollback** is a single `flyctl releases rollback` — Fly keeps prior releases, and the SQLite database lives on the volume independent of the release, so reverting code does not touch cache state.
- **Database migrations** are a different story. Kysely migrations in `lib/db/migrations.ts` are forward-only today; a bad migration is not rolled back, it is patched forward. Until smellgate has real users whose data is worth protecting, avoid migrations that drop columns or destructively reshape tables — prefer additive changes that can be cleaned up in a later migration.
