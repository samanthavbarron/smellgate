/**
 * Tap → read-cache dispatch for `com.smellgate.*` records.
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
import * as smellgate from "../lexicons/com/smellgate";
import { isCurator } from "../curators";
import type { DatabaseSchema } from "../db";

// ---------------------------------------------------------------------------
// Collection NSIDs (single source of truth). Mirrors the generated
// lexicon modules; kept explicit so the dispatch `switch` is readable.
// ---------------------------------------------------------------------------
export const SMELLGATE_COLLECTIONS = {
  perfume: "com.smellgate.perfume",
  perfumeSubmission: "com.smellgate.perfumeSubmission",
  perfumeSubmissionResolution: "com.smellgate.perfumeSubmissionResolution",
  shelfItem: "com.smellgate.shelfItem",
  review: "com.smellgate.review",
  description: "com.smellgate.description",
  vote: "com.smellgate.vote",
  comment: "com.smellgate.comment",
} as const;

export const SMELLGATE_COLLECTION_LIST: readonly string[] = Object.freeze(
  Object.values(SMELLGATE_COLLECTIONS),
);

const VOTE_DIRECTIONS = new Set(["up", "down"]);
const RESOLUTION_DECISIONS = new Set(["approved", "rejected", "duplicate"]);

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Dispatch a Tap record event to the right `com.smellgate.*` handler.
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
  if (!isCurator(evt.did)) return;
  const result = smellgate.perfume.$safeParse(evt.record);
  if (!result.success) return;
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
  if (!result.success) return;
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
  if (!isCurator(evt.did)) return;
  const result = smellgate.perfumeSubmissionResolution.$safeParse(evt.record);
  if (!result.success) return;
  const record = result.value;

  // Closed-enum gate: lexicon only types `decision` as a string at
  // runtime, so enforce the `knownValues` ourselves.
  if (!RESOLUTION_DECISIONS.has(record.decision)) return;

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
  if (!result.success) return;
  const record = result.value;

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
  if (!result.success) return;
  const record = result.value;

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
  if (!result.success) return;
  const record = result.value;

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
  if (!result.success) return;
  const record = result.value;

  // Closed-enum gate: direction must be "up" or "down".
  if (!VOTE_DIRECTIONS.has(record.direction)) return;

  await db
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
}

async function handleComment(
  db: Kysely<DatabaseSchema>,
  evt: RecordEvent,
  uri: string,
  indexedAt: number,
): Promise<void> {
  const result = smellgate.comment.$safeParse(evt.record);
  if (!result.success) return;
  const record = result.value;

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
