# Local multi-agent bug-bash setup

This is the developer-facing guide for the multi-agent bug-bash workflow
introduced in issue #106. It lets you run several AI agents (or humans
typing one CLI command per "user action") as simulated users of a locally
deployed `smellgate` instance, so multi-user interaction bugs that the
unit and integration suites don't cover have a chance to fall out before
shipping.

The whole setup is local-only and 100% in-process. There is no Docker
container, no real `plc.directory` traffic, and no real PDS — just two
long-running Node processes (the dev network and the dev server) plus
short-lived `pnpm agent:as` invocations.

## Pieces

- `scripts/dev-network.ts` (`pnpm dev:network`) — boots an in-process
  PDS + PLC via `@atproto/dev-env`'s `TestNetworkNoAppView`, provisions
  five known accounts, writes their URLs + DIDs + passwords to
  `.smellgate-dev-env.json`, then sleeps until killed.
- `lib/auth/client.ts` — when `SMELLGATE_DEV_HANDLE_RESOLVER` and
  `SMELLGATE_DEV_PLC_URL` are both set, the production `NodeOAuthClient`
  uses them for handle + DID resolution instead of the public defaults.
  Both unset = production behavior, untouched.
- `scripts/agent-as.ts` (`pnpm agent:as`) — a CLI that drives the full
  OAuth flow against the dev server (mirroring `completeOAuthFlow` from
  `tests/integration/oauth-pds.test.ts`), persists the resulting `did`
  cookie under `.smellgate-agent-sessions/<handle>.json`, and then
  performs a chosen action against the dev server's HTTP routes.

## End-to-end workflow

```sh
# 1. Start the dev network. Leave this running in its own shell.
pnpm dev:network
# It will print the env vars you need for step 3.

# 2. (in another shell) inspect the dev network state
cat .smellgate-dev-env.json
# {
#   "pdsUrl": "http://localhost:NNNNN",
#   "plcUrl": "http://localhost:MMMMM",
#   "curator": { "handle": "curator.test", "did": "did:plc:...", "password": "password-curator" },
#   "accounts": [ { "handle": "alice.test", ... }, ... ]
# }

# 3. Start the dev server with the dev-network env vars. Leave running.
SMELLGATE_DEV_HANDLE_RESOLVER=http://localhost:NNNNN \
SMELLGATE_DEV_PLC_URL=http://localhost:MMMMM \
SMELLGATE_CURATOR_DIDS=did:plc:... \
pnpm dev

# 4. Drive the app as one of the seeded users.
pnpm agent:as alice whoami
# {"handle":"alice.test","did":"did:plc:..."}
```

The first `pnpm agent:as <handle> ...` invocation drives the full OAuth
authorization-code flow against the dev server: it POSTs `/oauth/login`,
walks the PDS sign-in + consent endpoints, and follows the redirect into
`/oauth/callback`, where the dev server exchanges the code for an
`OAuthSession` and persists it in its own SQLite session store. The
agent CLI captures the `did` cookie the server sets and writes it to
`.smellgate-agent-sessions/<handle>.json`. Subsequent invocations as
the same handle short-circuit the OAuth dance and reuse the stored
cookie.

## Seeded accounts

| handle         | role         | password          |
| -------------- | ------------ | ----------------- |
| `alice.test`   | regular user | `password-alice`  |
| `bob.test`     | regular user | `password-bob`    |
| `carol.test`   | regular user | `password-carol`  |
| `dan.test`     | regular user | `password-dan`    |
| `curator.test` | curator      | `password-curator`|

The `pnpm agent:as` CLI accepts either the full handle (`alice.test`) or
the short alias (`alice`, `curator`).

## Supported actions

```sh
pnpm agent:as <handle> whoami
pnpm agent:as <handle> home
pnpm agent:as <handle> perfume <at-uri>
pnpm agent:as <handle> shelf add <perfume-uri> [--bottle-size 50] [--decant]
pnpm agent:as <handle> shelf list
pnpm agent:as <handle> review write <perfume-uri> --rating N --sillage N --longevity N --body "text"
pnpm agent:as <handle> description write <perfume-uri> --body "text"
pnpm agent:as <handle> vote <description-uri> up|down
pnpm agent:as <handle> comment <review-uri> --body "text"
pnpm agent:as <handle> submit '{"name":"X","house":"Y","notes":["a","b"]}'
pnpm agent:as curator curator pending
pnpm agent:as curator curator approve <submission-uri>
pnpm agent:as curator curator reject <submission-uri> [--note "..."]
pnpm agent:as curator curator duplicate <submission-uri> --canonical <perfume-uri>
```

Read actions (`home`, `perfume`, `shelf list`) hit the rendered HTML
pages and run a small regex over the result to summarize. Write actions
POST JSON to `app/api/smellgate/*/route.ts` exactly the way the in-app
client forms do. The CLI exercises the full HTTP path on purpose — it
does not call the server-action functions in `lib/server/` directly.

## Known limitations

- **No firehose / Tap consumer.** The dev network is a PDS, not a Tap
  feed. Records that the agent writes go to the user's PDS, but they
  do not propagate into the smellgate read cache (`smellgate_*`
  tables) until something drives the dispatcher. So
  `pnpm agent:as alice home` will show `perfumeCount: 0` until you
  also run `pnpm dev:seed-cache` to populate the cache, and curator
  `pending` will return `[]` even after a fresh `submit`. Wiring the
  dev network through the Tap dispatcher is a follow-up.
- **State is in-memory.** Killing `pnpm dev:network` discards every
  account, every PDS record, every DID. Sessions in
  `.smellgate-agent-sessions/` will then be stale (the dev server's
  SQLite session store still has them, but the OAuth client can no
  longer talk to a network that's gone). Delete the session directory
  and re-login. The agent CLI checks the stored DID against the
  current `.smellgate-dev-env.json` and forces a re-login if they
  diverge.
- **Dev server restarts are OK.** The server's session store is
  on-disk SQLite. As long as the dev network is the same, you can
  bounce `pnpm dev` without invalidating agent sessions.
- **Production code path is untouched** when neither
  `SMELLGATE_DEV_HANDLE_RESOLVER` nor `SMELLGATE_DEV_PLC_URL` is set.
  See the env-var gate in `lib/auth/client.ts`.
- **No browser involved.** Everything goes over `node:http` so we can
  set `sec-fetch-*` headers the way a real browser would (the OAuth
  provider API requires them, and `undici`'s global `fetch` strips
  them).
