# smellgate E2E (Playwright)

Black-box end-to-end tests that drive a real browser (Chromium) through
smellgate and the external services it depends on (bsky.social OAuth,
PLC lookups, etc). Implements the Playwright infrastructure half of
issue #216.

## Run modes

Select with `E2E_MODE`:

| Mode | Target | Credentials | Runner |
|------|--------|-------------|--------|
| `local` | `http://127.0.0.1:3000` + ephemeral `@atproto/dev-env` PDS | None — `run-local.ts` pre-creates an account on the PDS | `pnpm test:e2e:local` |
| `live` | `https://smellgate.app` (overridable with `SMELLGATE_E2E_URL`) | Real bsky account | `pnpm test:e2e` |

## Running locally

```bash
# Preferred: hermetic local mode. No external services, no secrets.
# `run-local.ts` boots an in-process PDS + PLC, pre-creates a test
# account, starts `next dev` pointed at them, then runs Playwright.
# Port 3000 must be free on your machine (the OAuth loopback client
# metadata hardcodes `redirect_uris: [".../127.0.0.1:3000/..."]`).
pnpm test:e2e:local

# Filter to a subset:
pnpm test:e2e:local --grep "anon-browse"
pnpm test:e2e:local --grep "OAuth"

# Live mode against prod. Provide creds as env vars or drop them in
# tests/e2e/.secrets (gitignored):
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

In live mode, if no credentials are found the OAuth login test skips
with a clear message; the anon-browse suite still runs. In local
mode credentials are always available (the orchestrator creates
them).

## Artifacts

Failing runs write to:

- `playwright-report/` — HTML report (open `index.html`).
- `test-results/` — Playwright's per-test traces / videos / screenshots.
- `tests/e2e/artifacts/<test-title>/` — custom network log + page HTML
  + screenshot dumped from the OAuth login test when it fails. This
  is the most useful artifact for diagnosing "bsky accepted but we
  never got redirected" bugs.

## CI

See `.github/workflows/e2e.yml`. Two jobs:

- **`local`** — runs on every `pull_request` and `push` to `main`. No
  secrets required. `run-local.ts` handles the full lifecycle.

- **`live`** — `workflow_dispatch` only. Hits `https://smellgate.app`
  (or a preview URL) with real bsky credentials. Uses secrets on the
  `production` GitHub Environment:
  - `E2E_BSKY_HANDLE` — e.g. `smellgate.bsky.social`
  - `E2E_BSKY_PASSWORD` — real account password (NOT an app-password)

  Trigger via **Actions → E2E → Run workflow → mode: live**. Optional
  inputs: `target_url`, `grep`.
