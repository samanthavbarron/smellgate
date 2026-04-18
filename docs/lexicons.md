# Lexicons & Data Model

This document is the source of truth for smellgate's data model. If you're implementing a lexicon or writing code that reads/writes records, start here. If you're changing the data model, update this file in the same PR.

## NSID namespace

All smellgate lexicons live under **`app.smellgate.*`** (the reverse of `smellgate.app`, the domain we own). Examples: `app.smellgate.perfume`, `app.smellgate.shelfItem`, `app.smellgate.review`.

We publish lexicon authority via a DNS TXT record on `_lexicon.smellgate.app` so that records written under this namespace can be machine-verified as authoritative.

### Lexicon authority publication

Per ATProto's [NSID resolution](https://atproto.com/specs/nsid) approach, the authority for an NSID is the DNS owner of the reversed domain. We own `smellgate.app`, which makes us the authority for everything under `app.smellgate.*`. To make this assertion machine-checkable, we publish a DNS TXT record at the conventional `_lexicon.<domain>` location:

- **Hostname:** `_lexicon.smellgate.app`
- **Type:** `TXT`
- **Value:** `did=<curator-account-DID>` — the DID of the smellgate curator account that owns the lexicon definitions. (The exact text format follows the [ATProto NSID resolution](https://atproto.com/specs/nsid) spec; if the spec has moved on by the time this is set, follow the spec, not this doc.)

**Status:** set. `_lexicon.smellgate.app` resolves to a TXT record with value `did=did:plc:l6l3piyd3hywg76f2udorm53` (confirmed via DNS-over-HTTPS). This is the DID of [`smellgate.bsky.social`](https://bsky.app/profile/smellgate.bsky.social), the production curator account. Local development and integration tests against an ephemeral PDS do not rely on the record.

## The canonical-identity problem, and how we solve it

In a PDS-only world, nothing inherently stops ten users from each creating a record for "Chanel No. 5". We need *some* notion of canonical identity so that reviews, shelves, descriptions, votes, and comments can all agree on what perfume they're about.

We surveyed how other ATProto apps handle this for shared catalogs (books/movies/TV):

- **Skylights** ([`my.skylights.rel`](https://github.com/Gregoor/skylights/blob/main/web/lexicons/rel.json)) has no catalog record at all. Reviews point at external IDs (TMDB, Open Library) and the UI fetches metadata live.
- **Bookhive** ([`buzz.bookhive.hiveBook`](https://github.com/nperez0111/bookhive/blob/main/lexicons/hiveBook.json) + [`buzz.bookhive.book`](https://github.com/nperez0111/bookhive/blob/main/lexicons/book.json)) has a canonical catalog record type, but it is **only written by the app operator's account** (`@bookhive.buzz`). User records reference it.

The Skylights pattern does not work for us: the perfume-world equivalents of TMDB/Open Library (Parfumo, Fragrantica, Basenotes) have terms of service that broadly prohibit the kind of scraping and redistribution we'd need, and there is no free, legally clean canonical ID space to delegate to.

**We adopt the Bookhive pattern.** A single operator-curated account publishes the canonical `app.smellgate.perfume` records. All user-authored records (shelf items, reviews, descriptions, votes, comments) reference a canonical perfume record by AT-URI. Users who want to add a perfume that doesn't exist yet write a `app.smellgate.perfumeSubmission` record, which curators review and (on approval) publish as a canonical `perfume`.

### Curator account

- Identity: [`samantha.wiki`](https://bsky.app/profile/samantha.wiki), DID `did:plc:sna3qx44beg2mb5fao44gsxh`. Its PDS holds the authoritative `app.smellgate.perfume` collection. (This is a stopgap while the dedicated `@smellgate.bsky.social` credentials are being recovered — will swap back once that account is reachable.)
- Curators: Samantha and Sam, manually, to start. No automated auto-approval in the initial implementation — humans look at every submission. This is acceptable because the initial catalog is small and the submission rate is zero.
- Curator tooling lives inside the smellgate app, gated by a config list of curator DIDs. This is the only piece of the app that has a concept of "admin" — keep it simple, no roles/permissions system.

### Seed catalog

The initial catalog is **seeded with synthetic (fake) perfumes**, generated with AI assistance. Rationale:

- Starting empty makes the app unusable for demos and integration tests.
- Scraping real perfume databases has legal risk we don't want to take on.
- Using real perfumes piecemeal ("I'll just add the ones I own") biases the catalog and creates awkward half-coverage.
- Synthetic perfumes sidestep all of this and give us enough variety to build and test the UI. They also make it obvious to users that the catalog is under construction.

Seed data lives in a versioned fixture file (not generated at runtime). The Phase 0 integration-test harness loads it into the local PDS so tests have something to reference. Production seeding is a one-time script that the curator account runs against its own PDS.

When real users show up and submit real perfumes, the catalog will accumulate real entries alongside the synthetic ones. We'll figure out pruning/migration of synthetic entries later — do not design for that now.

## Record types

All records use `tid` keys (the ATProto default for timestamp-ordered records) unless noted. All cross-record references use [`com.atproto.repo.strongRef`](https://atproto.com/specs/data-model#blob-type) (URI + CID) so references are immutable: if a curator edits a perfume record, existing reviews still pin the version they were written against.

### `app.smellgate.perfume` — canonical catalog entry

**Written by:** curator account only. Enforced at the app layer (the app refuses to surface or index `perfume` records authored by non-curator DIDs).

Fields:
- `name` (string, required)
- `house` (string, required) — the perfume house / brand (e.g. "Guerlain")
- `creator` (string, optional) — the perfumer / nose, when known (e.g. "Jacques Guerlain")
- `releaseYear` (integer, optional)
- `notes` (array of strings, required, min 1) — free-form tag strings. Normalized lowercase. The tag namespace is deliberately flat; we don't split into top/heart/base in v1.
- `description` (string, optional) — the "creator description" from PLAN.md. This is the curator-authored canonical blurb, distinct from community `description` records.
- `externalRefs` (array of objects, optional) — future-proofing for if we ever want to link out. Each: `{source: string, url: string}`. Do not use as a primary key.
- `createdAt` (datetime, required)

### `app.smellgate.perfumeSubmission` — user-proposed perfume

**Written by:** any authenticated user.

A submission is a proposal to add a perfume to the canonical catalog. Curators review it and either (a) publish a corresponding `app.smellgate.perfume` record and mark the submission resolved, or (b) reject it.

Fields: same shape as `perfume` (name/house/creator/releaseYear/notes/description), plus:
- `rationale` (string, optional, min 1 if present) — user's note to the curator. `minLength: 1` so an empty-string rationale is rejected at the lexicon layer (the field is optional, but if present it must carry content).
- `createdAt` (datetime, required)

There is no `status` field on the submission itself. Resolution is tracked by a separate curator-authored record (see `perfumeSubmissionResolution` below) so that submissions remain append-only from the submitter's perspective.

### `app.smellgate.perfumeSubmissionResolution` — curator decision

**Written by:** curator account only.

- `submission` (strongRef to a `perfumeSubmission`, required)
- `decision` (string enum: `"approved"` | `"rejected"` | `"duplicate"`, required)
- `perfume` (strongRef to a `app.smellgate.perfume`, optional) — set when `decision` is `"approved"` or `"duplicate"`; points at the canonical record the submission resolved to
- `note` (string, optional) — curator's explanation, shown to the submitter
- `createdAt` (datetime, required)

### `app.smellgate.shelfItem` — a perfume on a user's shelf

**Written by:** any user, about their own shelf.

- `perfume` (strongRef to `app.smellgate.perfume`, required)
- `acquiredAt` (datetime, optional)
- `bottleSizeMl` (integer, optional)
- `isDecant` (boolean, optional)
- `createdAt` (datetime, required)

### `app.smellgate.review` — a user's review of a perfume

**Written by:** any user.

- `perfume` (strongRef to `app.smellgate.perfume`, required)
- `rating` (integer 1–10, required) — overall
- `sillage` (integer 1–5, required)
- `longevity` (integer 1–5, required)
- `body` (string, required, min 1 / max ~15000 graphemes) — `minLength: 1` is enforced in the lexicon so a zero-length body fails `$safeParse`. ATProto's `required` only means the field is present; without `minLength` an empty string would validate.
- `createdAt` (datetime, required)

Scale choice: 1–10 for overall (gives more room for nuance than 1–5, and maps cleanly to a half-star-of-5 display when halved); 1–5 for sillage and longevity because those are coarser physical observations.

### `app.smellgate.description` — a community-authored description

**Written by:** any user. Distinct from the canonical `perfume.description` (which is curator-authored).

- `perfume` (strongRef to `app.smellgate.perfume`, required)
- `body` (string, required, min 1 / max ~5000 graphemes) — `minLength: 1` enforced in the lexicon, same rationale as `review.body`.
- `createdAt` (datetime, required)

### `app.smellgate.vote` — upvote/downvote on a description

**Written by:** any user.

- `subject` (strongRef to `app.smellgate.description`, required)
- `direction` (string enum: `"up"` | `"down"`, required)
- `createdAt` (datetime, required)

One vote per (user, description) is enforced at the **read layer**, not in the lexicon: the read cache keeps only the user's most recent vote per subject. This is fine because (a) ATProto can't enforce uniqueness across a user's records at write time, and (b) the cache is the source of truth for display.

### `app.smellgate.comment` — reply on a review

**Written by:** any user.

- `subject` (strongRef to `app.smellgate.review`, required)
- `body` (string, required, min 1 / max ~5000 graphemes) — `minLength: 1` enforced in the lexicon, same rationale as `review.body`.
- `createdAt` (datetime, required)

Threading model: **flat**. Comments reply only to reviews, not to other comments. Revisit later if users ask for it; do not build a tree now.

## The submission → canonical flow

When a user tries to add a perfume to their shelf (or review it, etc.) and the perfume doesn't exist in the catalog yet:

1. The client walks them through a "submit a new perfume" form.
2. The client writes a `app.smellgate.perfumeSubmission` to **their own PDS**.
3. The client **also** writes whatever the user originally wanted (shelfItem, review, etc.), but with the `perfume` strongRef pointing at the submission's AT-URI. These records are in a "pending" state from the app's perspective because the reference target is a submission rather than a canonical perfume.
4. A curator reviews the submission. On approval, the curator account writes a `app.smellgate.perfume` record and a `app.smellgate.perfumeSubmissionResolution` linking the two.
5. The client (or a backend rewriter) notices the resolution and rewrites the user's pending records to point at the canonical perfume AT-URI instead. This is a record edit, not a new record — the original `tid` and intent are preserved.
6. On `"duplicate"` resolution, the same rewrite happens but to the existing canonical record the curator identified.
7. On `"rejected"` resolution, the client prompts the user and offers to either edit the submission or delete the pending records.

The rewrite step (5) is the subtle bit. Alternatives we considered and rejected:

- **Reject everything that references a non-canonical perfume.** Bad UX — users lose their review if the submission is pending.
- **Eagerly copy the canonical fields into every user record.** Violates Pattern B (user records stop being references and become partial duplicates of the catalog).
- **Use a single "pending" placeholder record that's later deleted.** Leaves dangling references in the firehose and breaks the immutability property of strongRefs.

The chosen flow keeps user records as references throughout and uses the edit path to update them. Strongrefs still work because editing a record produces a new CID that the client can re-pin.

## Open questions

These don't block Phase 1 but should be resolved before Phase 4 (UI):

- **Duplicate detection on submission.** When a user submits "Chanel No 5", how does the client warn them that "Chanel No. 5" already exists? Probably fuzzy search over the cached catalog before accepting the submission.
- **Note normalization.** `"rose"`, `"Rose"`, `"rose absolute"`, `"bulgarian rose"` are all things users will type. v1: lowercase + trim, no synonym merging. Revisit.
- **Catalog editing.** What happens when a curator notices a typo in a published `perfume` record? Record edits work, but the strongRefs pinned by existing user records will point at the old CID. The read layer should follow the AT-URI (not the CID) when displaying a perfume page, and use the CID only to show "this review was written against version X". Write this up when we implement Phase 2.
