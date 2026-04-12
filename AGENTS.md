# AGENTS.md

Guidance for coding agents working on `smellgate`. Read [PLAN.md](PLAN.md) first for the product vision. This file covers **how** we build it.

## Ground rules

- **ATProto-native, no app database.** User records (shelf entries, reviews, descriptions, comments, votes) live in users' PDSs as records under our custom lexicons. The app is a view over the network, not a system of record. The only local storage is the auth session store and a Tap-fed read cache — never treat it as authoritative.
- **Issue → branch → PR → main.** Every unit of work starts as a GitHub issue and lands as a PR. No direct commits to `main`. Use `gh issue create`, `gh pr create`, `gh pr checks`. Before picking up work, run `gh issue list` and `gh pr list` to avoid colliding with another agent.
- **Parallel-agent safe.** Assume another agent is working at the same time. Scope PRs narrowly, keep them short-lived, rebase often. If two issues touch the same file, comment on the issue and coordinate instead of racing.
- **Test-first where it matters.** Unit tests for pure logic (lexicon validation, parsing, scoring). Integration tests for anything touching the PDS or OAuth — use a local PDS (`dev-env` / `pds` in a container) rather than mocks. A green unit suite with mocked ATProto calls is not a passing signal.
- **CI in GitHub Actions only.** Lint, typecheck, unit, and integration must run on every PR. No merging on red. Add the job in the same PR that introduces the code it tests.
- **Local dev first, hosting decided later.** Don't architect around any specific host. Cloudflare Pages/Workers was an early idea but is not a hard requirement — if it gets in the way, we'll pick something else. Avoid painting ourselves into a corner (e.g. don't adopt host-specific KV/DO APIs for core logic), but don't contort code to preserve Workers compatibility either.
- **Challenge dumb suggestions.** The humans here are strong on perfume and general dev but light on TS/JS. If a request would paint us into a corner (e.g. "just add a Postgres table"), push back and explain.

## Working mode and human oversight

The humans want to be **hands-off on implementation details** and only spend their attention on decisions that matter. Operate accordingly.

- **Default: proceed autonomously.** For routine implementation work — wiring up tests, adding a CI job, defining a lexicon that matches what's already in [docs/lexicons.md](docs/lexicons.md), writing boilerplate — just do it. Don't ask for permission on every step. Don't ask the user to pick between two reasonable equivalents; pick one, write down why in the PR, and move on.
- **Halt and ask when the decision is critical.** Stop and wait for human input before proceeding if any of these are true:
  - **Data model changes** beyond what [docs/lexicons.md](docs/lexicons.md) already specifies. New record types, renamed fields, changed semantics, changed reference patterns — all need sign-off. Lexicons in the wild are expensive to undo.
  - **Security-relevant choices:** auth scopes, credential storage, anything that touches OAuth session handling, anything that exposes user PDS write capability.
  - **Irreversible or hard-to-reverse actions:** force-pushes, history rewrites, deleting branches with unmerged work, rotating keys, publishing records to a production curator account, DNS changes.
  - **Cost or vendor lock-in:** signing up for a paid service, adopting a host-specific API for core logic, committing to an external dependency that isn't trivially swappable.
  - **Scope expansion:** if an issue's scope starts growing beyond what's written in the issue body, stop and either file a new issue or ask whether to expand the existing one. Don't let PRs silently balloon.
  - **You genuinely don't know** what the right call is and would be guessing. Asking is cheaper than being wrong.
- **How to halt.** Comment on the relevant issue or PR with a clear summary: what you were about to do, what decision is blocking you, what the options are, and what you'd recommend. Then stop work on that thread and pick up something else while waiting.
- **Proceed vs halt heuristic.** If the worst-case outcome of being wrong is "open a follow-up PR to fix it," proceed. If it's "users lose data," "we publish bad canonical records," "we can't merge to main anymore," or "we owe someone money" — halt.

## Adversarial review

Every non-trivial PR opened by a coding agent must be reviewed by a **separate adversarial-review agent** before being merged. The review agent's job is to find reasons *not* to merge, not to rubber-stamp.

- **Spawn a fresh subagent** for the review. It should not share context with the agent that wrote the PR — that's the whole point. Give it the PR URL, the linked issue, and [AGENTS.md](AGENTS.md) + [docs/lexicons.md](docs/lexicons.md), and ask it to report problems.
- **What the reviewer looks for:**
  - Does the PR actually close the issue as written, or is it solving a subtly different problem?
  - Are the tests real? A unit test that imports mocks and asserts on the mocks is not a test. Integration tests must hit the local PDS (see #7), not mocks.
  - Is anything in the diff out of scope for the linked issue? Unrelated "while I'm here" cleanups should be split out.
  - Does the PR violate any rule in [AGENTS.md](AGENTS.md) — new product DB, mocked PDS calls, direct commits to `main`, etc.?
  - For data-model PRs: does the change match [docs/lexicons.md](docs/lexicons.md) exactly? If the PR diverges from the doc, either the doc or the PR is wrong — flag it.
  - Security: any new attack surface, any credential mishandling, any unauthenticated write path.
  - Failure modes: what happens when the PDS is down, when a record is malformed, when the user logs out mid-operation? Is there any error handling, and if so, is it at the right layer (boundary, not everywhere)?
  - Simplicity: could this be half the code? Is there speculative abstraction? Are there fallbacks for scenarios that can't happen?
- **Reviewer behavior:** be direct, specific, and cite file:line. Push back on the authoring agent. Do not soften criticism. If the PR is fine, say so plainly — don't invent problems to justify the review.
- **Resolution:** the authoring agent responds to each reviewer comment with either a fix or a justification for not fixing. If the reviewer and author disagree and can't resolve it in one back-and-forth, **halt and escalate to the human** — don't loop indefinitely.
- **When to skip review:** never skip it on a PR with logic changes. Pure docs PRs (typo fixes, link updates) can go without review but must say so in the PR description. Config-only PRs (`.github/`, `package.json` tweaks) should still get review since those often have subtle blast radius.

The goal is not ceremony. The goal is: two independent agents looked at this, and the one whose job was to find problems didn't find any it cared about.

## Repo layout (inherited from statusphere starter)

- [app/](app/) — Next.js app router, routes and server actions
- [components/](components/) — React components
- [lexicons/xyz/](lexicons/xyz/) — ATProto lexicon JSON. **This is where the data model lives.** Will be renamed/extended under our own NSID (see Phase 1).
- [lib/auth/](lib/auth/) — OAuth client wiring
- [lib/db/](lib/db/) — SQLite-backed session + read cache (Kysely). Not a product DB.
- [lib/tap/](lib/tap/) — Firehose/Tap ingestion for populating the read cache
- [scripts/](scripts/) — `migrate.ts`, `gen-key.ts`

When in doubt about ATProto plumbing, the starter's patterns (OAuth session, Tap subscription, lexicon codegen via `pnpm build:lex`) are the reference.

## Commands

```sh
pnpm install
pnpm dev          # runs migrate + next dev
pnpm build:lex    # regenerate TS from lexicons/ — run after editing any lexicon
pnpm build
pnpm lint
```

`pnpm test` does not exist yet — adding it is part of Phase 0.

## Roadmap

Each phase is a set of issues. Phases are roughly sequential but issues within a phase are parallelizable unless noted. File each as a GitHub issue before starting; link the PR to the issue.

### Phase 0 — Foundations (unblocks everything else)

Goal: make the repo ours and make CI meaningful. Do this before any feature work.

1. **Rename + rebrand.** Update `package.json` name, README, remove statusphere-specific copy. Keep the commit small.
2. **NSID namespace: `com.smellgate.*`.** Domain is `smellgate.com`. All lexicons live under this namespace (e.g. `com.smellgate.perfume`, `com.smellgate.shelfItem`). Document in `docs/lexicons.md`.
3. **Test harness.** Add Vitest (lighter than Jest, Workers-friendly). Wire `pnpm test` and `pnpm test:integration`. One trivial passing test per tier so CI has something to run.
4. **CI workflow.** `.github/workflows/ci.yml`: install, `pnpm lint`, `tsc --noEmit`, `pnpm build:lex`, `pnpm test`, `pnpm build`. Required check on `main`.
5. **Local PDS for integration tests.** Script or compose file that brings up an ephemeral PDS and seeds a test account. Integration tests target it. This is the most important piece — do not skip it. Document how to run locally.
6. **AGENTS.md + CONTRIBUTING.md linkage.** Make sure new agents find this file.

### Phase 1 — Core lexicons (the data model IS the product)

Goal: define and validate the record types per [docs/lexicons.md](docs/lexicons.md). No UI yet. Every lexicon gets unit tests that round-trip valid + invalid fixtures.

We adopt the **Bookhive-style operator-curated catalog pattern** (see [docs/lexicons.md](docs/lexicons.md) for rationale): a dedicated curator account publishes canonical `com.smellgate.perfume` records, and all user records reference them by strongRef. Users propose new perfumes via `com.smellgate.perfumeSubmission`, which curators resolve.

1. **`com.smellgate.perfume`** — curator-only canonical catalog entry.
2. **`com.smellgate.perfumeSubmission`** — user-proposed perfume awaiting curator review.
3. **`com.smellgate.perfumeSubmissionResolution`** — curator-only decision record linking a submission to a canonical perfume (or rejecting it).
4. **`com.smellgate.shelfItem`** — a user's ownership entry.
5. **`com.smellgate.review`** — rating (1–10) + sillage + longevity + body.
6. **`com.smellgate.description`** — community-authored description (distinct from the curator's).
7. **`com.smellgate.vote`** — up/down on a description; uniqueness enforced at read layer.
8. **`com.smellgate.comment`** — flat reply on a review. No thread trees in v1.
9. **Codegen + fixtures.** `pnpm build:lex` green, fixtures checked in under `lexicons/fixtures/`, validator tests passing.
10. **Curator-only enforcement.** Read layer refuses to index `perfume` / `perfumeSubmissionResolution` records authored by non-curator DIDs. Curator DID list lives in config.
11. **Synthetic seed catalog.** AI-generated fake perfumes in a versioned fixture file, loaded into the local PDS by the integration-test harness and into the production curator PDS by a one-time seed script.

### Phase 2 — Read path (Tap ingest + cache)

1. **Subscribe to our collections** via Tap. Extend [lib/tap/](lib/tap/) to index our record types into the SQLite read cache.
2. **Query layer.** Kysely queries for: perfume by AT-URI, perfumes by note tag, perfumes by creator, user shelf, user reviews, user descriptions, description vote tallies, review comments.
3. **Cache invalidation / backfill story.** Document it. The cache can be rebuilt from the network — make sure that's actually true by writing a rebuild script and testing it.

### Phase 3 — Write path + OAuth-gated actions

Server actions for: add-to-shelf, remove-from-shelf, post review, post description, vote, comment, submit new perfume. Each writes to the signed-in user's PDS via their OAuth session and then (optimistically) updates the local cache. Integration-tested against the local PDS from Phase 0.

Also in Phase 3: **curator tooling.** A curator-only UI (gated by DID config) that lists pending `perfumeSubmission` records, lets a curator approve (publishing a canonical `perfume` + resolution), reject, or mark as duplicate. And the **submission rewrite flow** described in [docs/lexicons.md](docs/lexicons.md) — when a resolution is published, pending user records that reference the submission get rewritten to reference the canonical perfume. This is subtle; write it with integration tests from day one.

### Phase 4 — UI

Minimalist, letterboxd-ish. Do not over-design; Tailwind is already wired.

1. Perfume page: name, creator, notes-as-tags, creator description, reviews, community descriptions (sorted by votes).
2. Tag page: "perfumes with note X" and "perfumes by creator Y" — same underlying query.
3. Profile page: shelf, reviews authored, descriptions authored. Works for self and others.
4. Shelf management UI.
5. Review/description composer + comment UI.
6. Search (can start as simple substring over cached perfumes).

### Phase 5 — Deployment

Only after Phase 4 is usable locally. Pick a host that comfortably runs a Next.js app + a persistent Tap process + a small SQLite or Postgres read cache (Fly.io, Railway, a small VM, etc. — evaluate at the time based on price and operational overhead). Add a preview-deploy workflow.

### Phase 6+ — Later

Notifications, follows, lists, import from other perfume sites, moderation tools. Do not scope these now.

## Conventions for agents

- **Before starting:** `gh issue view <n>`, `gh pr list --search "is:open"`, `git pull`. Confirm nobody else is on it.
- **Branch name:** `<issue-number>-<short-slug>`.
- **PR:** link the issue (`Closes #N`), keep under ~400 lines of diff where possible, include a "How I tested" section naming the unit + integration tests that cover the change.
- **Do not merge your own PR without** green CI and either a human review or (for trivial/infra PRs) an explicit note in the issue authorizing self-merge.
- **After merge:** `gh pr checks` on the merge commit, verify `main` is green, close the issue if `Closes` didn't.
- **If you get stuck** on an ATProto/lexicon design question, stop and file a design issue rather than guessing. Bad data model decisions are expensive to reverse once records are in the wild.
