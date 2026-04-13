# smellgate

A letterboxd-style app for perfumes, built on [ATProto](https://atproto.com).

Log perfumes you own, rate them across overall impression / sillage / longevity, contribute community descriptions, vote on descriptions others have written, and browse each other's shelves. Built on the operator-curated catalog pattern from [Bookhive](https://bookhive.buzz/) — a dedicated curator account publishes the canonical perfume records, and user records (shelves, reviews, descriptions, comments, votes) reference them by AT-URI.

## Status

Feature-complete on localhost; not yet deployed. Every user journey from [PLAN.md](PLAN.md) works end-to-end: browse perfumes, view detail pages with notes-as-tags, browse by note / house / perfumer, view profiles, add to shelf, write reviews + descriptions + comments, vote on descriptions, submit new perfumes, and curator-approve / reject / mark-duplicate submissions — including the rewrite mechanic that repoints a user's pending records at the canonical perfume after a curator approves.

Pre-ship work is tracked in [issue #86](https://github.com/samanthavbarron/smellgate/issues/86), grouped by priority. The 3 hard blockers are: bootstrap a real curator account, fix a known bug in the production seeder script, and wire the hosted-metadata OAuth path for deployment.

## Try it locally

```sh
git clone https://github.com/samanthavbarron/smellgate.git
cd smellgate
cp env.template .env.local
# edit .env.local: set SMELLGATE_CURATOR_DIDS=did:plc:smellgate-dev-curator
pnpm install
pnpm dev:seed-cache   # populate the cache with 75 synthetic perfumes + 6 reviews
pnpm dev              # open http://127.0.0.1:3000
```

Most of the app is readable without logging in. OAuth only runs the loopback flow right now, so actual login is limited to `127.0.0.1` — the hosted-metadata path for real deployment is issue [#85](https://github.com/samanthavbarron/smellgate/issues/85).

## Tests

```sh
pnpm test              # unit (lexicon validators, queries, curators) — ~90 tests
pnpm test:integration  # integration against an in-process PDS (real OAuth + dispatcher + DB)
```

The integration tier boots a real ATProto PDS + PLC directory in-process via [`@atproto/dev-env`](https://www.npmjs.com/package/@atproto/dev-env). No docker, no external network.

## Where to find things

- **Product vision:** [PLAN.md](PLAN.md)
- **How we build:** [AGENTS.md](AGENTS.md) — working mode, adversarial review, repo layout, roadmap, resume-context
- **Data model:** [docs/lexicons.md](docs/lexicons.md) — the 8 `com.smellgate.*` record types and the submission → canonical flow
- **Frontend conventions:** [docs/ui.md](docs/ui.md)
- **Pre-ship backlog:** [issue #86](https://github.com/samanthavbarron/smellgate/issues/86)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)

## Credits

Bootstrapped from [`bluesky-social/statusphere-example-app`](https://github.com/bluesky-social/statusphere-example-app).
