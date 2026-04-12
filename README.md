# smellgate

A letterboxd-style app for perfumes, built on [ATProto](https://atproto.com). Log perfumes you own, write reviews (with ratings for sillage and longevity), contribute community descriptions, and browse other users' shelves.

See [PLAN.md](PLAN.md) for the product vision and [AGENTS.md](AGENTS.md) for how we build it.

## Status

Very early. The repo is currently scaffolding — we're working through Phase 0 (foundations) before any feature work lands. Track progress via [GitHub issues](https://github.com/samanthavbarron/smellgate/issues).

## Data model

smellgate is ATProto-native: user records (shelves, reviews, descriptions, votes, comments) live in users' PDSs under custom lexicons in the `com.smellgate.*` namespace. The canonical source of truth for record types, field shapes, reference conventions, and the curator-account / submission flow is [docs/lexicons.md](docs/lexicons.md). Read it before touching anything under `lexicons/` or writing code that reads or writes records.

## Getting Started

```sh
git clone https://github.com/samanthavbarron/smellgate.git
cd smellgate
cp env.template .env.local
pnpm install
pnpm dev
# Navigate to http://127.0.0.1:3000
```

To read data from the network, you'll need an instance of [Tap](https://github.com/bluesky-social/indigo/blob/main/cmd/tap/README.md) running.

## Running tests

```sh
pnpm test              # fast unit tests (no PDS, no network)
pnpm test:integration  # integration tests: boot an in-process PDS, drive
                       # a real OAuth authorization-code flow, write + read
                       # a record on it (see tests/integration/oauth-pds.test.ts)
```

## Local ephemeral PDS

Integration tests run against a real ATProto PDS — never against mocks, and
never against the public network. The PDS is started **in-process** by
[`@atproto/dev-env`](https://www.npmjs.com/package/@atproto/dev-env), which
also runs a local PLC directory inside the same Node process. Nothing
external is required: no docker, no `plc.directory`, no `pds:up` step.

### How it works

`tests/helpers/pds.ts` exposes the lifecycle:

- `startEphemeralPds()` — boots a fresh PDS + PLC on a random port and
  returns an `EphemeralPds` handle. State is empty on every call.
- `createTestAccounts(pds, specs?)` — creates the deterministic test
  accounts (default: `alice.test` / `alice-pw`, `bob.test` / `bob-pw`) and
  returns their DIDs + JWTs.
- `stopEphemeralPds(pds)` — tears the PDS + PLC down. State is discarded.

Lifecycle is explicit on purpose. There is no module-level singleton; the
caller (typically a Vitest `globalSetup` once #7's follow-up wires it in)
decides when to start and stop. To reset state between runs, just call
`stopEphemeralPds` and `startEphemeralPds` again — there's nothing on disk
to clean up.

### Default test accounts

| shortName | handle       | password   |
| --------- | ------------ | ---------- |
| `alice`   | `alice.test` | `alice-pw` |
| `bob`     | `bob.test`   | `bob-pw`   |

Override by passing your own `TestAccountSpec[]` to `createTestAccounts`.

### Pointing tests at the PDS

Test code gets the PDS URL from the `EphemeralPds` handle returned by
`startEphemeralPds`, and an `AtpAgent` from `pds.network.pds.getAgent()`.
Do not hard-code a port — every run picks a fresh one.

## Credits

Bootstrapped from the [`bluesky-social/statusphere-example-app`](https://github.com/bluesky-social/statusphere-example-app) starter.
