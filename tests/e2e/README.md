# smellgate E2E (Playwright)

Black-box end-to-end tests that drive a real browser (Chromium) through
smellgate and the external services it depends on (bsky.social OAuth,
PLC lookups, etc). Implements the Playwright infrastructure half of
issue #216.

## Run modes

Select with `E2E_MODE`:

| Mode | Target | Credentials | Status |
|------|--------|-------------|--------|
| `live` (default) | `https://smellgate.app` (overridable with `SMELLGATE_E2E_URL`) | Real bsky account | Shipped |
| `local` | `http://127.0.0.1:3000` + ephemeral `@atproto/dev-env` PDS | None (fixture mints accounts) | TODO — follow-up to #216 |

## Running locally

```bash
# Anon-browse tests — no credentials needed.
pnpm test:e2e --grep "anon-browse"

# All tests including OAuth login. Provide creds as env vars or
# drop them in tests/e2e/.secrets (gitignored):
#
#   SMELLGATE_BSKY_HANDLE=smellgate.bsky.social
#   SMELLGATE_BSKY_PASSWORD=<real-account-password>
#
# NOTE: the OAuth login test requires the account's REAL password,
# not a bsky app-password. App-passwords work for XRPC createSession
# but are rejected by the /oauth/authorize HTML form.
SMELLGATE_E2E_URL=https://smellgate.app \
  SMELLGATE_BSKY_HANDLE=smellgate.bsky.social \
  SMELLGATE_BSKY_PASSWORD=xxxxx \
  pnpm test:e2e
```

Credentials are loaded by `helpers/creds.ts` in this order:

1. Env vars (`SMELLGATE_BSKY_*`, `E2E_BSKY_*`, then `BSKY_*`).
2. `tests/e2e/.secrets` (gitignored, `KEY=VALUE` lines).
3. `/tmp/.test-creds` (the codespace convention — see `scripts/agent-as.ts`).

If no credentials are found, the OAuth login test skips with a clear
message; the anon-browse suite still runs.

## Artifacts

Failing runs write to:

- `playwright-report/` — HTML report (open `index.html`).
- `test-results/` — Playwright's per-test traces / videos / screenshots.
- `tests/e2e/artifacts/<test-title>/` — custom network log + page HTML
  + screenshot dumped from the OAuth login test when it fails. This
  is the most useful artifact for diagnosing "bsky accepted but we
  never got redirected" bugs.

## CI

See `.github/workflows/e2e.yml`. The workflow is `workflow_dispatch`
only for now (manual trigger). To enable it:

1. Go to repo **Settings → Environments → `production`**.
2. Add two secrets to that environment:
   - `E2E_BSKY_HANDLE` — e.g. `smellgate.bsky.social`
   - `E2E_BSKY_PASSWORD` — real account password (NOT an app-password)
3. Run **Actions → E2E → Run workflow**, pick branch, optionally
   override `SMELLGATE_E2E_URL` if you want to point at a preview
   deploy.

Scheduled runs (cron) and PR-gated runs are a follow-up once the
manual run is confirmed green.
