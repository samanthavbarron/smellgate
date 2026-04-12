# Contributing to smellgate

**Start with [AGENTS.md](AGENTS.md).** It is the working agreement for this repo (humans and agents alike). This file is just a pointer doc — it does not restate the rules.

## Workflow: issue → branch → PR → main

Every change starts as a GitHub issue and lands as a PR. No direct commits to `main`.

```sh
gh issue list                              # find or claim work
gh issue view <n>                          # read the scope
git checkout -b <n>-short-slug             # branch naming
# ...do the work, commit...
git push -u origin <n>-short-slug
gh pr create                               # body must say "Closes #<n>"
gh pr checks                               # CI must be green before merge
```

Before starting, also run `gh pr list --search "is:open"` so you don't collide with another agent.

## Branch naming

`<issue-number>-<short-slug>` — e.g. `9-contributing`.

## PR conventions

- Link the issue with `Closes #N` (or `Refs #N` if it's only partial).
- Keep diffs small — under ~400 lines where possible.
- Anything that touches the PDS needs an **integration test** against the local ephemeral PDS, not mocks. See AGENTS.md for the rationale.
- Fill in the PR template. The "How I tested" section must name the specific tests or commands that ran — "I ran the tests" is not enough.

## Running it locally

See [README.md "Getting Started"](README.md#getting-started).

## Running tests

See [README.md "Running tests"](README.md#running-tests) and [README.md "Local ephemeral PDS"](README.md#local-ephemeral-pds) for the integration-test harness.

## Data model questions

The lexicons are the product. Read [docs/lexicons.md](docs/lexicons.md) before proposing any record-shape change, and halt for human sign-off if your change would diverge from what's documented there.

## If you're an agent

Read all of [AGENTS.md](AGENTS.md), and pay particular attention to:

- [Working mode and human oversight](AGENTS.md#working-mode-and-human-oversight) — when to proceed autonomously vs. halt and ask.
- [Adversarial review](AGENTS.md#adversarial-review) — non-trivial PRs get reviewed by a fresh subagent before merge.
