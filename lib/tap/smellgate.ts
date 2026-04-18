/**
 * Tap → read-cache dispatch for `app.smellgate.*` records.
 *
 * This module is the "index-time" side of Phase 2. It takes a Tap
 * record event (`create` | `update` | `delete` for one of our 8
 * collections), validates the record body against the generated
 * lexicon `$safeParse`, applies the record-type-specific gates
 * (curator-only for `perfume` / `perfumeSubmissionResolution`,
 * closed-enum runtime checks for `vote.direction` and
 * `perfumeSubmissionResolution.decision`), and writes into the
 * matching row of the Kysely-backed cache.
 *
 * Design notes:
 *
 * - The NSID dispatch is a single `switch` on `evt.collection`. Adding
 *   a new record type means adding a case and a handler; nothing else.
 * - The existing `xyz.statusphere.status` plumbing in
 *   `app/api/webhook/route.ts` is untouched. When the webhook is
 *   rewired to call this dispatcher in a follow-up, the webhook
 *   becomes the single caller in production; tests call the
 *   dispatcher directly today.
 * - Records that fail lexicon validation are silently dropped.
 *   Firehose volume is high and we don't want to log per-record.
 * - Records that fail the curator gate (non-curator authoring a
 *   curator-only record) are silently dropped. Same reason.
 * - Records that fail the closed-enum gate (e.g. a vote with
 *   `direction: "sideways"`) are silently dropped. The lexicon is
 *   typed-only on these fields, so the check has to happen here —
 *   see `$knownValues` discussion in docs/lexicons.md.
 * - Strong refs (`perfume`, `subject`, `submission`) are stored as
 *   plain `(uri, cid)` string pairs. We do not resolve them against
 *   other cache tables at index time: firehose order is not
 *   dependency order, so a vote can legitimately arrive before its
 *   description and we don't want to drop it.
 * - No foreign keys. References between tables are AT-URI strings.
 */

import { AtUri } from "@atproto/syntax";
import type { RecordEvent } from "@atproto/tap";
import { Kysely } from "kysely";
import * as smellgate from "../lexicons/app/smellgate";
import { isCurator } from "../curators";
import type { DatabaseSchema } from "../db";
import { countGraphemes } from "../graphemes";
import commentLexicon from "../../lexicons/app/smellgate/comment.json";
import descriptionLexicon from "../../lexicons/app/smellgate/description.json";
import reviewLexicon from "../../lexicons/app/smellgate/review.json";

// ---------------------------------------------------------------------------
// Collection NSIDs (single source of truth). Mirrors the generated
// lexicon modules; kept explicit so the dispatch `switch` is readable.
// ---------------------------------------------------------------------------
export const SMELLGATE_COLLECTIONS = {
  perfume: "app.smellgate.perfume",
  perfumeSubmission: "app.smellgate.perfumeSubmission",
  perfumeSubmissionResolution: "app.smellgate.perfumeSubmissionResolution",
  shelfItem: "app.smellgate.shelfItem",
  review: "app.smellgate.review",
  description: "app.smellgate.description",
  vote: "app.smellgate.vote",
  comment: "app.smellgate.comment",
} as const;

export const SMELLGATE_COLLECTION_LIST: readonly string[] = Object.freeze(
  Object.values(SMELLGATE_COLLECTIONS),
);

const VOTE_DIRECTIONS = new Set(["up", "down"]);
const RESOLUTION_DECISIONS = new Set(["approved", "rejected", "duplicate"]);

// ---------------------------------------------------------------------------
// Body-length bounds for free-text fields (issues #189, #193, #196).
//
// These are defense-in-depth at the dispatcher layer mirroring the
// server-action guards in `lib/server/smellgate-actions.ts`. We read
// the `maxGraphemes` bound out of the lexicon JSON at module-load so
// the number follows the lexicon rather than getting out of sync with
// a hardcoded literal.
//
// `$safeParse` already enforces `maxGraphemes` and `minLength: 1`, but
// whitespace-only bodies pass `minLength: 1` (graphemes, not
// non-whitespace characters — see #185/#193/#196). We add an explicit
// trim-then-minLength check here so direct PDS writes matching the
// lexical bound but visually empty get dropped.
// ---------------------------------------------------------------------------
const REVIEW_BODY_MAX_GRAPHEMES: number = (
  reviewLexicon as { defs: { main: { record: { properties: { body: { maxGraphemes: number } } } } } }
).defs.main.record.properties.body.maxGraphemes;
const DESCRIPTION_BODY_MAX_GRAPHEMES: number = (
  descriptionLexicon as { defs: { main: { record: { properties: { body: { maxGraphemes: number } } } } } }
).defs.main.record.properties.body.maxGraphemes;
const COMMENT_BODY_MAX_GRAPHEMES: number = (
  commentLexicon as { defs: { main: { record: { properties: { body: { maxGraphemes: number } } } } } }
).defs.main.record.properties.body.maxGraphemes;

// ---------------------------------------------------------------------------
// Drop-site observability (#47).
//
// The dispatcher silently drops records that fail a gate: curator-only
// authorship, lexicon `$safeParse`, closed-enum checks. Silent is the
// right production default (firehose volume + a single bad-actor PDS
// can flood logs), but when debugging a mis-seen record it's
// miserable. This optional debug hook logs each drop with enough
// context to track down what was dropped and why.
//
// Opt-in via `SMELLGATE_TAP_DEBUG=1`. Reads the env var fresh on each
// call so tests can stub it. Uses `console.debug` so Node's default
// log level still hides these unless someone has set
// `NODE_DEBUG`/inspector attached. Tests that drop records (and there
// are several in `tests/integration/tap-smellgate-cache.test.ts`)
// will NOT emit these lines because `SMELLGATE_TAP_DEBUG` is unset in
// the test env.
// ---------------------------------------------------------------------------
type DropReason =
  | "curator_gate"
  | "lex_validate"
  | "closed_enum"
  // Strongref points at a record in the wrong collection. E.g. a
  // `shelfItem.perfume` pointing at an `app.smellgate.perfumeSubmission`,
  // or a `vote.subject` pointing at a perfume rather than a description.
  // See issues #168, #180, #183, #194, #195.
  | "bad_collection_ref"
  // `body` is empty or whitespace-only after trim (issues #185, #193, #196),
  // or exceeds `maxGraphemes` (issue #189).
  | "bad_body"
  // Self-vote: author DID equals the description author DID. Mirrors the
  // server-action guard in `voteOnDescriptionAction` (issue #191).
  | "self_vote";

function logDrop(
  reason: DropReason,
  evt: RecordEvent,
  uri: string,
  extra?: Record<string, unknown>,
): void {
  if (process.env.SMELLGATE_TAP_DEBUG !== "1") return;
  console.debug(`[tap] drop: ${reason}`, {
    collection: evt.collection,
    did: evt.did,
    uri,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Dispatch a Tap record event to the right `app.smellgate.*` handler.
 *
 * - Returns without touching the DB if the event's collection isn't one
 *   of ours. The webhook route forwards every record event to this
 *   function; non-smellgate events are a no-op.
 * - `create` and `update` go through the same write path (upsert).
 * - `delete` removes the row from the matching table. We rely on
 *   `ON DELETE CASCADE`-style manual cleanup for note join tables.
 */
export async function dispatchSmellgateEvent(
  db: Kysely<DatabaseSchema>,
  evt: RecordEvent,
): Promise<void> {
  const { collection } = evt;
  if (!SMELLGATE_COLLECTION_LIST.includes(collection)) return;
  const uri = AtUri.make(evt.did, evt.collection, evt.rkey).toString();

  if (evt.action === "delete") {
    await deleteByUri(db, collection, uri);
    return;
  }

  // create | update both need a validated body and a cid.
  if (!evt.record || !evt.cid) return;
  const indexedAt = Date.now();

  switch (collection) {
    case SMELLGATE_COLLECTIONS.perfume:
      await handlePerfume(db, evt, uri, indexedAt);
      return;
    case SMELLGATE_COLLECTIONS.perfumeSubmission:
      await handlePerfumeSubmission(db, evt, uri, indexedAt);
      return;
    case SMELLGATE_COLLECTIONS.perfumeSubmissionResolution:
      await handlePerfumeSubmissionResolution(db, evt, uri, indexedAt);
      return;
    case SMELLGATE_COLLECTIONS.shelfItem:
      await handleShelfItem(db, evt, uri, indexedAt);
      return;
    case SMELLGATE_COLLECTIONS.review:
      await handleReview(db, evt, uri, indexedAt);
      return;
    case SMELLGATE_COLLECTIONS.description:
      await handleDescription(db, evt, uri, indexedAt);
      return;
    case SMELLGATE_COLLECTIONS.vote:
      await handleVote(db, evt, uri, indexedAt);
      return;
    case SMELLGATE_COLLECTIONS.comment:
      await handleComment(db, evt, uri, indexedAt);
      return;
  }
}

// ---------------------------------------------------------------------------
// Per-record-type handlers. Each one:
//   1. runs the generated `$safeParse` → drop on failure
//   2. runs any record-type-specific gate (curator, enum) → drop on failure
//   3. upserts the cache row (and join-table rows where applicable)
// ---------------------------------------------------------------------------

async function handlePerfume(
  db: Kysely<DatabaseSchema>,
  evt: RecordEvent,
  uri: string,
  indexedAt: number,
): Promise<void> {
  // Curator-only: enforce at index time, per docs/lexicons.md.
  if (!isCurator(evt.did)) {
    logDrop("curator_gate", evt, uri);
    return;
  }
  const result = smellgate.perfume.$safeParse(evt.record);
  if (!result.success) {
    logDrop("lex_validate", evt, uri);
    return;
  }
  const record = result.value;

  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto("smellgate_perfume")
      .values({
        uri,
        cid: evt.cid!,
        author_did: evt.did,
        indexed_at: indexedAt,
        name: record.name,
        house: record.house,
        creator: record.creator ?? null,
        release_year: record.releaseYear ?? null,
        description: record.description ?? null,
        external_refs_json: record.externalRefs
          ? JSON.stringify(record.externalRefs)
          : null,
        created_at: record.createdAt,
      })
      .onConflict((oc) =>
        oc.column("uri").doUpdateSet({
          cid: evt.cid!,
          author_did: evt.did,
          indexed_at: indexedAt,
          name: record.name,
          house: record.house,
          creator: record.creator ?? null,
          release_year: record.releaseYear ?? null,
          description: record.description ?? null,
          external_refs_json: record.externalRefs
            ? JSON.stringify(record.externalRefs)
            : null,
          created_at: record.createdAt,
        }),
      )
      .execute();

    // Replace note tags. Updates may shrink/grow the tag set.
    await tx
      .deleteFrom("smellgate_perfume_note")
      .where("perfume_uri", "=", uri)
      .execute();
    const noteRows = dedupeNotes(record.notes).map((note) => ({
      perfume_uri: uri,
      note,
    }));
    if (noteRows.length > 0) {
      await tx.insertInto("smellgate_perfume_note").values(noteRows).execute();
    }
  });
}

async function handlePerfumeSubmission(
  db: Kysely<DatabaseSchema>,
  evt: RecordEvent,
  uri: string,
  indexedAt: number,
): Promise<void> {
  const result = smellgate.perfumeSubmission.$safeParse(evt.record);
  if (!result.success) {
    logDrop("lex_validate", evt, uri);
    return;
  }
  const record = result.value;

  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto("smellgate_perfume_submission")
      .values({
        uri,
        cid: evt.cid!,
        author_did: evt.did,
        indexed_at: indexedAt,
        name: record.name,
        house: record.house,
        creator: record.creator ?? null,
        release_year: record.releaseYear ?? null,
        description: record.description ?? null,
        rationale: record.rationale ?? null,
        created_at: record.createdAt,
      })
      .onConflict((oc) =>
        oc.column("uri").doUpdateSet({
          cid: evt.cid!,
          author_did: evt.did,
          indexed_at: indexedAt,
          name: record.name,
          house: record.house,
          creator: record.creator ?? null,
          release_year: record.releaseYear ?? null,
          description: record.description ?? null,
          rationale: record.rationale ?? null,
          created_at: record.createdAt,
        }),
      )
      .execute();

    await tx
      .deleteFrom("smellgate_perfume_submission_note")
      .where("submission_uri", "=", uri)
      .execute();
    const noteRows = dedupeNotes(record.notes).map((note) => ({
      submission_uri: uri,
      note,
    }));
    if (noteRows.length > 0) {
      await tx
        .insertInto("smellgate_perfume_submission_note")
        .values(noteRows)
        .execute();
    }
  });
}

async function handlePerfumeSubmissionResolution(
  db: Kysely<DatabaseSchema>,
  evt: RecordEvent,
  uri: string,
  indexedAt: number,
): Promise<void> {
  // Curator-only.
  if (!isCurator(evt.did)) {
    logDrop("curator_gate", evt, uri);
    return;
  }
  const result = smellgate.perfumeSubmissionResolution.$safeParse(evt.record);
  if (!result.success) {
    logDrop("lex_validate", evt, uri);
    return;
  }
  const record = result.value;

  // Closed-enum gate: lexicon only types `decision` as a string at
  // runtime, so enforce the `knownValues` ourselves.
  if (!RESOLUTION_DECISIONS.has(record.decision)) {
    logDrop("closed_enum", evt, uri, { field: "decision", value: record.decision });
    return;
  }

  await db
    .insertInto("smellgate_perfume_submission_resolution")
    .values({
      uri,
      cid: evt.cid!,
      author_did: evt.did,
      indexed_at: indexedAt,
      submission_uri: record.submission.uri,
      submission_cid: record.submission.cid,
      decision: record.decision as "approved" | "rejected" | "duplicate",
      perfume_uri: record.perfume?.uri ?? null,
      perfume_cid: record.perfume?.cid ?? null,
      note: record.note ?? null,
      created_at: record.createdAt,
    })
    .onConflict((oc) =>
      oc.column("uri").doUpdateSet({
        cid: evt.cid!,
        author_did: evt.did,
        indexed_at: indexedAt,
        submission_uri: record.submission.uri,
        submission_cid: record.submission.cid,
        decision: record.decision as "approved" | "rejected" | "duplicate",
        perfume_uri: record.perfume?.uri ?? null,
        perfume_cid: record.perfume?.cid ?? null,
        note: record.note ?? null,
        created_at: record.createdAt,
      }),
    )
    .execute();
}

async function handleShelfItem(
  db: Kysely<DatabaseSchema>,
  evt: RecordEvent,
  uri: string,
  indexedAt: number,
): Promise<void> {
  const result = smellgate.shelfItem.$safeParse(evt.record);
  if (!result.success) {
    logDrop("lex_validate", evt, uri);
    return;
  }
  const record = result.value;

  // Issue #168: `shelfItem.perfume` must point at an
  // `app.smellgate.perfume`, not a submission or any other record.
  const perfumeCol = atUriCollection(record.perfume.uri);
  if (perfumeCol !== SMELLGATE_COLLECTIONS.perfume) {
    logDrop("bad_collection_ref", evt, uri, {
      field: "perfume.uri",
      expected: SMELLGATE_COLLECTIONS.perfume,
      got: perfumeCol,
    });
    return;
  }

  await db
    .insertInto("smellgate_shelf_item")
    .values({
      uri,
      cid: evt.cid!,
      author_did: evt.did,
      indexed_at: indexedAt,
      perfume_uri: record.perfume.uri,
      perfume_cid: record.perfume.cid,
      acquired_at: record.acquiredAt ?? null,
      bottle_size_ml: record.bottleSizeMl ?? null,
      is_decant:
        record.isDecant === undefined ? null : record.isDecant ? 1 : 0,
      created_at: record.createdAt,
    })
    .onConflict((oc) =>
      oc.column("uri").doUpdateSet({
        cid: evt.cid!,
        author_did: evt.did,
        indexed_at: indexedAt,
        perfume_uri: record.perfume.uri,
        perfume_cid: record.perfume.cid,
        acquired_at: record.acquiredAt ?? null,
        bottle_size_ml: record.bottleSizeMl ?? null,
        is_decant:
          record.isDecant === undefined ? null : record.isDecant ? 1 : 0,
        created_at: record.createdAt,
      }),
    )
    .execute();
}

async function handleReview(
  db: Kysely<DatabaseSchema>,
  evt: RecordEvent,
  uri: string,
  indexedAt: number,
): Promise<void> {
  const result = smellgate.review.$safeParse(evt.record);
  if (!result.success) {
    logDrop("lex_validate", evt, uri);
    return;
  }
  const record = result.value;

  // Issue #194: `review.perfume` must point at an app.smellgate.perfume.
  const perfumeCol = atUriCollection(record.perfume.uri);
  if (perfumeCol !== SMELLGATE_COLLECTIONS.perfume) {
    logDrop("bad_collection_ref", evt, uri, {
      field: "perfume.uri",
      expected: SMELLGATE_COLLECTIONS.perfume,
      got: perfumeCol,
    });
    return;
  }

  // Issue #193: trim-then-minLength and maxGraphemes gate. The lexicon's
  // `minLength: 1` passes whitespace-only bodies and the `maxGraphemes`
  // check is already in `$safeParse`, but an explicit drop here gives a
  // cleaner debug log and keeps the dispatcher symmetrical with the
  // server-action guard in `postReviewAction`.
  if (!validateBody(record.body, REVIEW_BODY_MAX_GRAPHEMES).ok) {
    logDrop("bad_body", evt, uri, {
      field: "body",
      reason: "empty-after-trim or over maxGraphemes",
    });
    return;
  }

  await db
    .insertInto("smellgate_review")
    .values({
      uri,
      cid: evt.cid!,
      author_did: evt.did,
      indexed_at: indexedAt,
      perfume_uri: record.perfume.uri,
      perfume_cid: record.perfume.cid,
      rating: record.rating,
      sillage: record.sillage,
      longevity: record.longevity,
      body: record.body,
      created_at: record.createdAt,
    })
    .onConflict((oc) =>
      oc.column("uri").doUpdateSet({
        cid: evt.cid!,
        author_did: evt.did,
        indexed_at: indexedAt,
        perfume_uri: record.perfume.uri,
        perfume_cid: record.perfume.cid,
        rating: record.rating,
        sillage: record.sillage,
        longevity: record.longevity,
        body: record.body,
        created_at: record.createdAt,
      }),
    )
    .execute();
}

async function handleDescription(
  db: Kysely<DatabaseSchema>,
  evt: RecordEvent,
  uri: string,
  indexedAt: number,
): Promise<void> {
  const result = smellgate.description.$safeParse(evt.record);
  if (!result.success) {
    logDrop("lex_validate", evt, uri);
    return;
  }
  const record = result.value;

  // Issue #180: `description.perfume` must point at an app.smellgate.perfume.
  const perfumeCol = atUriCollection(record.perfume.uri);
  if (perfumeCol !== SMELLGATE_COLLECTIONS.perfume) {
    logDrop("bad_collection_ref", evt, uri, {
      field: "perfume.uri",
      expected: SMELLGATE_COLLECTIONS.perfume,
      got: perfumeCol,
    });
    return;
  }

  // Issues #185, #189: empty-after-trim or over maxGraphemes.
  if (!validateBody(record.body, DESCRIPTION_BODY_MAX_GRAPHEMES).ok) {
    logDrop("bad_body", evt, uri, {
      field: "body",
      reason: "empty-after-trim or over maxGraphemes",
    });
    return;
  }

  await db
    .insertInto("smellgate_description")
    .values({
      uri,
      cid: evt.cid!,
      author_did: evt.did,
      indexed_at: indexedAt,
      perfume_uri: record.perfume.uri,
      perfume_cid: record.perfume.cid,
      body: record.body,
      created_at: record.createdAt,
    })
    .onConflict((oc) =>
      oc.column("uri").doUpdateSet({
        cid: evt.cid!,
        author_did: evt.did,
        indexed_at: indexedAt,
        perfume_uri: record.perfume.uri,
        perfume_cid: record.perfume.cid,
        body: record.body,
        created_at: record.createdAt,
      }),
    )
    .execute();
}

async function handleVote(
  db: Kysely<DatabaseSchema>,
  evt: RecordEvent,
  uri: string,
  indexedAt: number,
): Promise<void> {
  const result = smellgate.vote.$safeParse(evt.record);
  if (!result.success) {
    logDrop("lex_validate", evt, uri);
    return;
  }
  const record = result.value;

  // Closed-enum gate: direction must be "up" or "down".
  if (!VOTE_DIRECTIONS.has(record.direction)) {
    logDrop("closed_enum", evt, uri, { field: "direction", value: record.direction });
    return;
  }

  // Issue #183: `vote.subject` must point at an app.smellgate.description.
  const subjectCol = atUriCollection(record.subject.uri);
  if (subjectCol !== SMELLGATE_COLLECTIONS.description) {
    logDrop("bad_collection_ref", evt, uri, {
      field: "subject.uri",
      expected: SMELLGATE_COLLECTIONS.description,
      got: subjectCol,
    });
    return;
  }

  // Issue #191a: self-vote guard. The description URI's authority is
  // its author DID (at://<did>/...), so we can derive the author
  // without a DB round-trip. If the voter is voting on their own
  // description, drop. Mirrors the server-action guard in
  // `voteOnDescriptionAction`.
  const subjectAuthor = atUriAuthority(record.subject.uri);
  if (subjectAuthor !== null && subjectAuthor === evt.did) {
    logDrop("self_vote", evt, uri, {
      subject: record.subject.uri,
    });
    return;
  }

  // Issue #191b: duplicate-vote cleanup at index time. The
  // server-action `voteOnDescriptionAction` deletes any prior vote
  // records from the same author on the same subject before writing
  // the new one. Direct PDS writes bypass that. Here, when a vote
  // arrives, remove any prior row in the cache keyed by (author_did,
  // subject_uri) before upserting the new one. The user's PDS still
  // has the prior vote records — this only keeps the cache clean so
  // `loadVoteTallies` doesn't have to rely solely on indexed_at
  // dedupe. Wrap in a transaction so the delete and upsert commit
  // atomically.
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("smellgate_vote")
      .where("author_did", "=", evt.did)
      .where("subject_uri", "=", record.subject.uri)
      .where("uri", "!=", uri)
      .execute();

    await tx
      .insertInto("smellgate_vote")
      .values({
        uri,
        cid: evt.cid!,
        author_did: evt.did,
        indexed_at: indexedAt,
        subject_uri: record.subject.uri,
        subject_cid: record.subject.cid,
        direction: record.direction as "up" | "down",
        created_at: record.createdAt,
      })
      .onConflict((oc) =>
        oc.column("uri").doUpdateSet({
          cid: evt.cid!,
          author_did: evt.did,
          indexed_at: indexedAt,
          subject_uri: record.subject.uri,
          subject_cid: record.subject.cid,
          direction: record.direction as "up" | "down",
          created_at: record.createdAt,
        }),
      )
      .execute();
  });
}

async function handleComment(
  db: Kysely<DatabaseSchema>,
  evt: RecordEvent,
  uri: string,
  indexedAt: number,
): Promise<void> {
  const result = smellgate.comment.$safeParse(evt.record);
  if (!result.success) {
    logDrop("lex_validate", evt, uri);
    return;
  }
  const record = result.value;

  // Issue #195: `comment.subject` must point at an app.smellgate.review.
  // Per the lexicon's own description: "Comments reply only to reviews,
  // not to other comments. No thread trees in v1."
  const subjectCol = atUriCollection(record.subject.uri);
  if (subjectCol !== SMELLGATE_COLLECTIONS.review) {
    logDrop("bad_collection_ref", evt, uri, {
      field: "subject.uri",
      expected: SMELLGATE_COLLECTIONS.review,
      got: subjectCol,
    });
    return;
  }

  // Issue #196: empty-after-trim or over maxGraphemes.
  if (!validateBody(record.body, COMMENT_BODY_MAX_GRAPHEMES).ok) {
    logDrop("bad_body", evt, uri, {
      field: "body",
      reason: "empty-after-trim or over maxGraphemes",
    });
    return;
  }

  await db
    .insertInto("smellgate_comment")
    .values({
      uri,
      cid: evt.cid!,
      author_did: evt.did,
      indexed_at: indexedAt,
      subject_uri: record.subject.uri,
      subject_cid: record.subject.cid,
      body: record.body,
      created_at: record.createdAt,
    })
    .onConflict((oc) =>
      oc.column("uri").doUpdateSet({
        cid: evt.cid!,
        author_did: evt.did,
        indexed_at: indexedAt,
        subject_uri: record.subject.uri,
        subject_cid: record.subject.cid,
        body: record.body,
        created_at: record.createdAt,
      }),
    )
    .execute();
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function deleteByUri(
  db: Kysely<DatabaseSchema>,
  collection: string,
  uri: string,
): Promise<void> {
  switch (collection) {
    case SMELLGATE_COLLECTIONS.perfume:
      await db.transaction().execute(async (tx) => {
        await tx
          .deleteFrom("smellgate_perfume_note")
          .where("perfume_uri", "=", uri)
          .execute();
        await tx
          .deleteFrom("smellgate_perfume")
          .where("uri", "=", uri)
          .execute();
      });
      return;
    case SMELLGATE_COLLECTIONS.perfumeSubmission:
      await db.transaction().execute(async (tx) => {
        await tx
          .deleteFrom("smellgate_perfume_submission_note")
          .where("submission_uri", "=", uri)
          .execute();
        await tx
          .deleteFrom("smellgate_perfume_submission")
          .where("uri", "=", uri)
          .execute();
      });
      return;
    case SMELLGATE_COLLECTIONS.perfumeSubmissionResolution:
      await db
        .deleteFrom("smellgate_perfume_submission_resolution")
        .where("uri", "=", uri)
        .execute();
      return;
    case SMELLGATE_COLLECTIONS.shelfItem:
      await db
        .deleteFrom("smellgate_shelf_item")
        .where("uri", "=", uri)
        .execute();
      return;
    case SMELLGATE_COLLECTIONS.review:
      await db.deleteFrom("smellgate_review").where("uri", "=", uri).execute();
      return;
    case SMELLGATE_COLLECTIONS.description:
      await db
        .deleteFrom("smellgate_description")
        .where("uri", "=", uri)
        .execute();
      return;
    case SMELLGATE_COLLECTIONS.vote:
      await db.deleteFrom("smellgate_vote").where("uri", "=", uri).execute();
      return;
    case SMELLGATE_COLLECTIONS.comment:
      await db.deleteFrom("smellgate_comment").where("uri", "=", uri).execute();
      return;
  }
}

/**
 * Parse `uri` and return its collection segment, or `null` if the URI
 * is malformed. Used by the collection-ref guards (issues #168, #180,
 * #183, #194, #195) to drop events whose strongRef targets the wrong
 * record type. We don't resolve the ref against the cache — firehose
 * order is not dependency order, so a legitimate vote can arrive
 * before its description — but a ref whose NSID segment is clearly
 * wrong (e.g. a vote pointing at a perfume, or a shelfItem pointing
 * at a perfumeSubmission) is unambiguously bogus regardless of
 * arrival order.
 */
function atUriCollection(uri: string): string | null {
  try {
    return new AtUri(uri).collection;
  } catch {
    return null;
  }
}

/**
 * `authority` (the DID) of an AT-URI, or `null` if the input is not a
 * parseable AT-URI. Used by the self-vote guard (#191): the description
 * URI's hostname is its author's DID — no DB round-trip needed.
 */
function atUriAuthority(uri: string): string | null {
  try {
    return new AtUri(uri).hostname;
  } catch {
    return null;
  }
}

/**
 * Validate a free-text body: trim, reject empty / whitespace-only,
 * reject > maxGraphemes. Returns `{ ok: true, body }` on success (body
 * is the trimmed value — but we don't write the trimmed version back
 * to the cache because the dispatcher stores records verbatim; this is
 * only a gate). Returns `{ ok: false, reason }` on failure so the
 * caller can emit a single `logDrop` line.
 *
 * Whitespace-only rejection mirrors the server-action layer's
 * `rawBody.trim().length === 0` check (issues #185, #193, #196).
 *
 * We count graphemes with `Intl.Segmenter` via `countGraphemes` to
 * agree with the lexicon's `maxGraphemes` semantic. The `$safeParse`
 * already enforces `maxGraphemes` via the generated validator, so this
 * extra length check is belt-and-braces; the explicit drop here gives
 * a cleaner `logDrop` reason than the generic `lex_validate` when
 * debugging (issue #189).
 */
function validateBody(
  raw: unknown,
  max: number,
): { ok: true } | { ok: false } {
  if (typeof raw !== "string") return { ok: false };
  if (raw.trim().length === 0) return { ok: false };
  if (countGraphemes(raw) > max) return { ok: false };
  return { ok: true };
}

/**
 * Notes are already constrained to minLength 1 by the lexicon, but the
 * join-table primary key is `(uri, note)`, so duplicates within a
 * single record would explode the insert. Deduplicate defensively.
 */
function dedupeNotes(notes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of notes) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
