# AGENTS.md

Guidance for coding agents working on `smellgate`. Read [PLAN.md](PLAN.md) first for the product vision. This file covers **how** we build it.

## Current state (2026-04-13)

Phases 0–4 of the roadmap are all complete. The app is feature-complete end-to-end on localhost, not yet deployed. Remaining work is categorized as **production blockers** (3 items), **P1 polish** (7 items), and a longer tail of P2/P3 follow-ups tracked in GitHub issues.

- **Source of truth for what's left:** issue #86 (the META tracking issue). It groups the remaining work by priority and lists the exact steps needed to ship.
- **Finding issues by priority:** `gh issue list --label P0-blocker` / `--label P1-critical` / `--label P2-polish` / `--label P3-nice-to-have`
- **Finding production blockers:** `gh issue list --label "blocker:production"` (currently #1, #40, #85)
- **Phase 5 (deployment)** is not yet scoped into issues. Do it when the P0s are clear — see the meta issue for the recommended order.

A fresh session resuming this work should: (1) read this file end-to-end, (2) read [docs/lexicons.md](docs/lexicons.md) for the data model, (3) read [docs/ui.md](docs/ui.md) for frontend conventions, (4) look at #86 to see what's next, (5) resume the same loop: pick an issue → spawn an implementation agent in a worktree → spawn a fresh adversarial reviewer → merge.

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
  - Are the tests real? A unit test that imports mocks and asserts on the mocks is not a test. Integration tests must hit the local in-process PDS from `tests/helpers/pds.ts`, not mocks.
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

## Repo layout

- [app/](app/) — Next.js app router (Turbopack)
  - `app/page.tsx` — home (recent perfumes + recent reviews)
  - `app/perfume/[uri]/` — perfume detail + composer routes (shelf/new, review/new, description/new)
  - `app/tag/{note,house,creator}/[value]/` — tag listing pages
  - `app/profile/[did]/` + `app/profile/me/` — profile pages
  - `app/submit/` — new-perfume submission form
  - `app/review/[uri]/comment/new/` — comment composer
  - `app/curator/` — curator dashboard (server-gated on `isCurator`)
  - `app/search/` — substring search
  - `app/api/smellgate/{shelf,review,description,vote,comment,submission,curator/*}/` — OAuth-gated POST route handlers
  - `app/api/webhook/` — Tap ingest webhook (dispatches both legacy statusphere and smellgate records)
  - `app/oauth/{login,logout,callback}/` — OAuth flow routes
- [components/](components/) — React components
  - `SiteHeader.tsx`, `PerfumeTile.tsx`, `TagPage.tsx` — layout primitives
  - `components/forms/` — client composer forms (Shelf, Review, Description, Vote, Comment, PerfumeSubmission)
  - `components/curator/` — curator-side client components
- [lexicons/](lexicons/) — ATProto lexicon JSON
  - `lexicons/com/smellgate/` — our 8 record types (the data model; see [docs/lexicons.md](docs/lexicons.md))
  - `lexicons/com/atproto/repo/strongRef.json` — vendored upstream lexicon for cross-references
  - `lexicons/xyz/statusphere/status.json` — legacy starter lexicon, still used by the webhook's statusphere branch
- [lib/auth/](lib/auth/) — OAuth client wiring (hosted metadata via `PUBLIC_URL` + `PRIVATE_KEY`, loopback fallback for local dev)
- [lib/curators.ts](lib/curators.ts) — `isCurator(did)` + DID list parsing (reads `SMELLGATE_CURATOR_DIDS` at module load)
- [lib/db/](lib/db/) — SQLite + Kysely
  - `migrations.ts` — schema migrations (additive; the smellgate cache tables were added in Phase 2.A)
  - `index.ts` — `getDb()` + Kysely table types
  - `queries.ts` — legacy statusphere queries + the Tap identity resolver (`getAccountHandle`)
  - `smellgate-queries.ts` — 13+ typed queries for the read path. Includes `loadVoteTallies` helper for read-time vote dedupe.
- [lib/tap/](lib/tap/) — Tap dispatch. `lib/tap/smellgate.ts` has `dispatchSmellgateEvent(db, evt)` which applies the curator gate + closed-enum gate + lexicon validation before upserting.
- [lib/server/](lib/server/) — server-side pure functions called by the route handlers
  - `smellgate-actions.ts` — `addToShelfAction`, `postReviewAction`, `postDescriptionAction`, `voteOnDescriptionAction`, `commentOnReviewAction`, `submitPerfumeAction`
  - `smellgate-curator-actions.ts` — `listPendingSubmissionsAction`, `approveSubmissionAction`, `rejectSubmissionAction`, `markDuplicateAction`, and the login-hook `rewritePendingRecords`
- [scripts/](scripts/) — dev + ops scripts
  - `migrate.ts` — run Kysely migrations (invoked by `pnpm dev` and `pnpm start`)
  - `gen-key.ts` — generate signing key for hosted OAuth (needed for production deploy)
  - `seed-cache-from-fixtures.ts` — dev-only: populate the local cache with synthetic perfumes via the real dispatcher (used by `pnpm dev:seed-cache`)
  - `seed-catalog.ts` — production-only one-shot to write the synthetic catalog to a curator PDS. **Has a known OAuth wrapper bug (#40) — do not run.**
  - `rebuild-cache.ts` — drop + rebuild the smellgate cache tables from the network (`pnpm cache:rebuild`)
- [tests/](tests/)
  - `tests/helpers/pds.ts` — `startEphemeralPds`, `createTestAccounts`, `createTestOAuthClient` (in-process PDS via `@atproto/dev-env`)
  - `tests/unit/` — unit tests (93+ total across lexicons, queries, curators, seed-catalog)
  - `tests/integration/` — integration tests (43+ total: OAuth, Tap dispatch, webhook, cache rebuild, server actions, curator flow)
  - `tests/fixtures/com/smellgate/` — lexicon validator fixtures
  - `tests/fixtures/seed-catalog.json` — 75 synthetic perfumes
- [docs/](docs/)
  - `docs/lexicons.md` — **data model source of truth.** Read before modifying any record type.
  - `docs/ui.md` — Phase 4 design conventions (Tailwind inline, amber accent, zinc neutrals). Read before adding any UI.

## Commands

```sh
pnpm install
pnpm dev                 # runs migrate + next dev (loopback OAuth)
pnpm dev:seed-cache      # populate local cache with 75 synthetic perfumes + 6 reviews via the real dispatcher
pnpm build:lex           # regenerate TS from lexicons/ — run after editing any lexicon JSON
pnpm typecheck           # runs build:lex + tsc --noEmit (self-sufficient, won't see stale generated-path errors)
pnpm test                # Vitest unit tier (90+ tests)
pnpm test:integration    # Vitest integration tier (in-process PDS; 43+ tests)
pnpm build               # Next.js production build
pnpm lint                # ESLint flat-config; ignores `.claude/worktrees/**` so sibling worktrees don't leak in (#38)
pnpm cache:rebuild       # read all records from a source PDS, drop the smellgate cache, re-index
pnpm cache:rebuild:dry-run
pnpm seed:catalog        # one-shot production seeder — DO NOT RUN, has bug (#40)
pnpm seed:catalog:dry-run
pnpm gen-key             # generate OAuth signing key for hosted deploy (Phase 5)
pnpm migrate             # Kysely migrations only
```

## Roadmap

Each phase is (or was) a set of issues. Phases are roughly sequential but issues within a phase are parallelizable unless noted. Every unit of work starts as a GitHub issue and lands as a PR.

### ✅ Phase 0 — Foundations (DONE)

Rebrand (#4), Vitest harness (#6), local in-process PDS via `@atproto/dev-env` (#7/#17/#19), CI workflow (#8), CONTRIBUTING + PR template (#9), NSID docs (#5), rebrand cleanup sweep (#29). Vitest runs two tiers: `pnpm test` (unit) and `pnpm test:integration` (hits the in-process PDS via `tests/helpers/pds.ts`). CI is `.github/workflows/ci.yml`, required on `main`.

### ✅ Phase 1 — Data model (DONE)

Pattern B (Bookhive-style operator-curated catalog; see [docs/lexicons.md](docs/lexicons.md) for the rationale and rejected alternatives). 8 record types under `com.smellgate.*`, fixtures + validator tests (#31 / PR #34). Curator enforcement library `lib/curators.ts` with env-var-driven DID list (#32 / PR #37). Synthetic seed catalog of 75 fake perfumes at `tests/fixtures/seed-catalog.json` (#33 / PR #39).

### ✅ Phase 2 — Read path (DONE)

Cache schema + Tap dispatcher (#42 / PR #45): 10 tables including `smellgate_perfume_note` join for tag lookups, single `dispatchSmellgateEvent` function gating on curator/closed-enum before upsert. Webhook wiring into `app/api/webhook/route.ts` (#46 / PR #48). Typed Kysely query layer with 13+ functions and read-time vote dedupe (#43 / PR #50). Cache rebuild script + test that drops and reconstructs the cache from PDS listings (#44 / PR #51).

### ✅ Phase 3 — Write path (DONE)

5 OAuth-gated server actions for shelf/review/description/vote/comment via route handlers under `app/api/smellgate/` backed by pure functions in `lib/server/smellgate-actions.ts` (#54 / PR #56). Submission flow + 4 curator endpoints + the **rewrite mechanic** that runs on login from `app/oauth/callback/route.ts` to repoint pending user records at newly-canonical perfumes (#55 / PR #59). OAuth `SCOPE` broadened from `repo:xyz.statusphere.status` to `transition:generic` (#57 / PR #65).

Phase 3.A (a server-side data layer between queries and UI) was considered and explicitly skipped — server components call the Phase 2.B queries directly.

### ✅ Phase 4 — UI (DONE)

Design conventions documented in [docs/ui.md](docs/ui.md) — plain Tailwind inline, amber accent, zinc neutrals, no component primitive library, no web fonts, no icon libs. 6 sub-PRs:

- **4.A** layout shell + home page (#66 / PR #72)
- **4.B** perfume detail + 3 tag pages (by note / house / creator) (#67 / PR #74) — note the Next.js 16 Turbopack quirk: dynamic segment params are NOT auto-decoded, must call `decodeURIComponent` explicitly
- **4.C** profile pages with stacked shelf/reviews/descriptions sections (#68 / PR #77) — required a second round to add vote-tally rendering on description cards; the fix introduced a shared `loadVoteTallies` helper in `smellgate-queries.ts`
- **4.D** 6 composer forms + real `VoteButtons` (#69 / PR #80) — uses plain `fetch()` to the Phase 3 POST endpoints, no server actions layer
- **4.E** curator dashboard with inline approve/reject/duplicate actions (#70 / PR #81)
- **4.F** substring search with LIKE-escape safety and unit tests for the escape behavior (#71 / PR #79)

### 🟦 Phase 5 — Deployment (NOT STARTED)

Prerequisites tracked as P0 blockers in issue #86: bootstrap curator account (#1), fix seed-catalog OAuth wrapper (#40), wire hosted OAuth metadata (#85). Once those are clear, pick a host. **Not Cloudflare Workers** — the Tap consumer needs a long-running process. Fly.io, Railway, or a small VM are the candidates. Preview deploys via `.github/workflows/`.

### Phase 6+ — Later

Notifications, follows, lists, import from other perfume sites, moderation tools beyond curator gating, multi-curator voting on submissions, real search (FTS / vector), shelf edit + delete, review edit. Do not scope these until Phase 5 is shipping and there's real user feedback to prioritize against.

## Backlog organization

Open issues are labeled with exactly one priority tier:

- **`P0-blocker`** — hard blocker for shipping. Always crossed with `blocker:production`. Currently 3: #1, #40, #85.
- **`P1-critical`** — fix during the pre-ship polish pass. Data integrity, test hardening, contributor UX. Currently 7.
- **`P2-polish`** — nice to have before shipping, not blocking. Currently ~15.
- **`P3-nice-to-have`** — maybe someday. Currently 3.

Plus these cross-cut / organizational labels:

- **`blocker:production`** — must be resolved before any real user can use the app. Currently P0s only.
- **`meta`** — tracking / planning issue, not a unit of work. Currently just #86 (the pre-ship checklist).
- **`phase-N`** (0-4) — historical attribution for what phase the issue was filed under.

**Issue #86 is the master tracking board** for shipping. It lists every remaining item grouped by priority with a recommended ship order. Update it when you close anything significant.

## Conventions for agents

- **Before starting:** `gh issue view <n>`, `gh pr list --search "is:open"`, `git pull`. Confirm nobody else is on it.
- **Branch name:** `<issue-number>-<short-slug>`.
- **PR:** link the issue (`Closes #N` when the PR fully resolves it; `Refs #N` for PRs that only partially address an issue without closing it — one keyword per issue, GitHub only auto-closes the first one without repeated `closes`), keep under ~400 lines of diff where possible, include a "How I tested" section naming the commands and tests that cover the change, and a "Scope check" section explicitly listing what you did and did not touch.
- **Do not merge your own PR without** green CI AND an approved adversarial-review verdict.
- **After merge:** `gh pr checks` on the merge commit, verify `main` is green, close the issue if `Closes` didn't, clean up the worktree with `git worktree remove --force` + `git branch -D`.
- **If you get stuck** on an ATProto/lexicon design question, stop and file a design issue rather than guessing. Bad data model decisions are expensive to reverse once records are in the wild.

### Worktree isolation

Implementation agents run in isolated git worktrees (`.claude/worktrees/agent-<id>/`) branched from `main`. A few recurring failure modes to watch for:

- **Files accidentally written to the main tree instead of the worktree.** Several agents have hit this when using absolute paths like `/workspaces/smellgate/app/foo.tsx` from inside a worktree'd session. If the orchestrator notices untracked files in main that belong to an in-progress agent, clean them (`rm -rf`) — the agent will have its own copy inside the worktree. Warn the agent about it in their next message if they're still active.
- **Dev servers left running.** Agents that do browser tests sometimes leave `next dev` processes on port 3000/3001. Before spawning a new agent that needs the dev server, `pkill -f "next dev"` to clear them.
- **`.next/dev/lock` contention.** If multiple agents try to run `pnpm dev` simultaneously they'll collide on this lock file. `rm -rf .next` to clear.

### Adversarial review is part of the workflow, not optional

- **Non-trivial PRs:** always spawn a fresh adversarial reviewer (new agent, no shared context with the author). Pass the PR URL, the linked issue number, and the paths to `AGENTS.md` and `docs/lexicons.md`.
- **Trivial PRs (single-line config, doc typo):** may be merged without review, but the PR description must explicitly say so and justify.
- **Review verdicts:** `approve` / `request-changes` / `block`. Merge only on `approve`. On `request-changes`, send the implementation agent back via `SendMessage` with specifics. On `block`, halt and escalate to the human.
- **Admin-merge bypass:** use `gh pr merge --squash --admin` for approved PRs. Branch protection requires a check named `lint / typecheck / test / build` — if it's not green, do not bypass.

### Running the dev server for manual smoke testing

```sh
rm -rf .next                              # clear any stale build state / locks
pkill -f "next dev"                       # kill any stray dev servers on 3000/3001
pnpm dev:seed-cache                       # populate the cache with synthetic data
nohup pnpm dev > /tmp/smellgate-dev.log 2>&1 &   # detach from parent so it survives
disown
```

`.env.local` needs at least `SMELLGATE_CURATOR_DIDS=did:plc:smellgate-dev-curator` so the seed curator can write perfume records. A full starter `.env.local` is the same as `env.template`.

In a GitHub Codespace, Next.js picks port 3000 if free, otherwise 3001. The forwarded URL follows the pattern `https://<codespace-name>-<port>.app.github.dev` — approve the port forwarding prompt on first access.

The loopback OAuth flow only works at 127.0.0.1, so **actual login will fail** from a Codespaces forwarded URL. Browse anonymously; most of the app is readable without auth. For real OAuth testing you need the hosted-metadata path from #85.

### Picking up a stalled task

Implementation and review agents sometimes take 5–17 minutes on substantive work and look "stalled" (output file at 131 bytes for minutes). The pattern has been: wait 5–10 minutes before declaring an agent dead. If you do spawn a replacement, the original often finishes anyway — that's fine for reviewers (two reviews is harmless) but wasteful for implementation agents (two PRs means one gets closed).

If an agent reports something that contradicts what's actually on `main` (e.g. "AGENTS.md section X doesn't exist" when it clearly does), suspect stale context — the agent may be reading from a worktree checked out at an older commit. Verify the truth yourself before acting on the report.
