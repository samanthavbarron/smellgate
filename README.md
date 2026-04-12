# smellgate

A letterboxd-style app for perfumes, built on [ATProto](https://atproto.com). Log perfumes you own, write reviews (with ratings for sillage and longevity), contribute community descriptions, and browse other users' shelves.

See [PLAN.md](PLAN.md) for the product vision and [AGENTS.md](AGENTS.md) for how we build it.

## Status

Very early. The repo is currently scaffolding — we're working through Phase 0 (foundations) before any feature work lands. Track progress via [GitHub issues](https://github.com/samanthavbarron/smellgate/issues).

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

## Credits

Bootstrapped from the [`bluesky-social/statusphere-example-app`](https://github.com/bluesky-social/statusphere-example-app) starter.
