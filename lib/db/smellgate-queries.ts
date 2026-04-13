/**
 * Kysely query layer for the `com.smellgate.*` read cache (Phase 2.B).
 *
 * These functions read from the tables populated by
 * `lib/tap/smellgate.ts`. Every query takes an explicit
 * `db: Kysely<DatabaseSchema>` parameter so callers can wire in a
 * per-test database, a rebuild script's database, or the
 * app-singleton `getDb()` — the module is not coupled to any one.
 *
 * Design notes:
 *
 * - No mocks anywhere. The only way these queries run is against a
 *   real SQLite file with the real migration applied.
 * - Every "list" query takes optional `limit` / `offset` pagination.
 *   Defaults are `limit: 50`, `offset: 0` — big enough for a typical
 *   profile or tag page, small enough to not be a footgun.
 * - Vote uniqueness (per docs/lexicons.md: "One vote per (user,
 *   description) is enforced at the read layer") is handled at query
 *   time in `getVoteTally` and `getDescriptionsForPerfume`. Phase 2.A's
 *   dispatcher writes every vote record it sees — `smellgate_vote.uri`
 *   is the row key, so two votes from the same author on the same
 *   subject end up as two distinct rows. The dedupe rule is: "keep
 *   each author's most recent vote per `subject_uri`, as ordered by
 *   `indexed_at`". We implement that as a window-style
 *   `GROUP BY author_did` + `MAX(indexed_at)` self-filter.
 * - Joins between perfumes and their notes use a single round-trip
 *   per query (perfume rows + a single `WHERE perfume_uri IN (...)`
 *   lookup for notes), then assembled in JS. This keeps the Kysely
 *   query builder happy without sprouting raw SQL for group_concat,
 *   and matches the shape the UI will consume.
 * - Comments and reviews stream back in the order a human would read
 *   them: reviews newest-first (`indexed_at DESC`), comments
 *   oldest-first (`indexed_at ASC`).
 */

import { Kysely, sql } from "kysely";
import type {
  DatabaseSchema,
  SmellgatePerfumeTable,
  SmellgateShelfItemTable,
  SmellgateReviewTable,
  SmellgateDescriptionTable,
  SmellgateCommentTable,
  SmellgatePerfumeSubmissionTable,
  SmellgatePerfumeSubmissionResolutionTable,
} from ".";

type Db = Kysely<DatabaseSchema>;

export interface PaginationOpts {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;

function paged(opts?: PaginationOpts): { limit: number; offset: number } {
  return {
    limit: opts?.limit ?? DEFAULT_LIMIT,
    offset: opts?.offset ?? DEFAULT_OFFSET,
  };
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * A perfume row bundled with its note tags. This is what every
 * perfume-returning query hands back — the UI always wants notes
 * alongside the base row, and doing it here avoids N+1 round-trips.
 */
export type PerfumeWithNotes = SmellgatePerfumeTable & { notes: string[] };

export type ShelfItemWithPerfume = SmellgateShelfItemTable & {
  perfume: PerfumeWithNotes | null;
};

export interface VoteTally {
  up: number;
  down: number;
}

export type DescriptionWithVotes = SmellgateDescriptionTable & {
  up_count: number;
  down_count: number;
  score: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load notes for a set of perfume URIs and group them by URI. One
 * query, regardless of how many perfumes you pass in.
 */
async function loadNotesByPerfume(
  db: Db,
  perfumeUris: string[],
): Promise<Map<string, string[]>> {
  const byUri = new Map<string, string[]>();
  if (perfumeUris.length === 0) return byUri;
  const rows = await db
    .selectFrom("smellgate_perfume_note")
    .select(["perfume_uri", "note"])
    .where("perfume_uri", "in", perfumeUris)
    .execute();
  for (const row of rows) {
    const arr = byUri.get(row.perfume_uri);
    if (arr) arr.push(row.note);
    else byUri.set(row.perfume_uri, [row.note]);
  }
  return byUri;
}

async function attachNotes(
  db: Db,
  perfumes: SmellgatePerfumeTable[],
): Promise<PerfumeWithNotes[]> {
  const notesByUri = await loadNotesByPerfume(
    db,
    perfumes.map((p) => p.uri),
  );
  return perfumes.map((p) => ({ ...p, notes: notesByUri.get(p.uri) ?? [] }));
}

// ---------------------------------------------------------------------------
// Perfume reads
// ---------------------------------------------------------------------------

export async function getPerfumeByUri(
  db: Db,
  uri: string,
): Promise<PerfumeWithNotes | null> {
  const row = await db
    .selectFrom("smellgate_perfume")
    .selectAll()
    .where("uri", "=", uri)
    .executeTakeFirst();
  if (!row) return null;
  const notesByUri = await loadNotesByPerfume(db, [uri]);
  return { ...row, notes: notesByUri.get(uri) ?? [] };
}

export async function getPerfumesByNote(
  db: Db,
  note: string,
  opts?: PaginationOpts,
): Promise<PerfumeWithNotes[]> {
  const { limit, offset } = paged(opts);
  const perfumes = await db
    .selectFrom("smellgate_perfume")
    .innerJoin(
      "smellgate_perfume_note",
      "smellgate_perfume_note.perfume_uri",
      "smellgate_perfume.uri",
    )
    .where("smellgate_perfume_note.note", "=", note)
    .selectAll("smellgate_perfume")
    .orderBy("smellgate_perfume.indexed_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
  return attachNotes(db, perfumes);
}

export async function getPerfumesByHouse(
  db: Db,
  house: string,
  opts?: PaginationOpts,
): Promise<PerfumeWithNotes[]> {
  const { limit, offset } = paged(opts);
  const perfumes = await db
    .selectFrom("smellgate_perfume")
    .selectAll()
    .where("house", "=", house)
    .orderBy("indexed_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
  return attachNotes(db, perfumes);
}

export async function getPerfumesByCreator(
  db: Db,
  creator: string,
  opts?: PaginationOpts,
): Promise<PerfumeWithNotes[]> {
  const { limit, offset } = paged(opts);
  const perfumes = await db
    .selectFrom("smellgate_perfume")
    .selectAll()
    .where("creator", "=", creator)
    .orderBy("indexed_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
  return attachNotes(db, perfumes);
}

// ---------------------------------------------------------------------------
// User-scoped reads
// ---------------------------------------------------------------------------

export async function getUserShelf(
  db: Db,
  did: string,
  opts?: PaginationOpts,
): Promise<ShelfItemWithPerfume[]> {
  const { limit, offset } = paged(opts);
  const items = await db
    .selectFrom("smellgate_shelf_item")
    .selectAll()
    .where("author_did", "=", did)
    .orderBy("indexed_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
  if (items.length === 0) return [];

  const perfumeUris = Array.from(new Set(items.map((i) => i.perfume_uri)));
  const perfumeRows = await db
    .selectFrom("smellgate_perfume")
    .selectAll()
    .where("uri", "in", perfumeUris)
    .execute();
  const perfumesWithNotes = await attachNotes(db, perfumeRows);
  const byUri = new Map(perfumesWithNotes.map((p) => [p.uri, p]));

  return items.map((item) => ({
    ...item,
    perfume: byUri.get(item.perfume_uri) ?? null,
  }));
}

export async function getUserReviews(
  db: Db,
  did: string,
  opts?: PaginationOpts,
): Promise<SmellgateReviewTable[]> {
  const { limit, offset } = paged(opts);
  return db
    .selectFrom("smellgate_review")
    .selectAll()
    .where("author_did", "=", did)
    .orderBy("indexed_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
}

export async function getUserDescriptions(
  db: Db,
  did: string,
  opts?: PaginationOpts,
): Promise<SmellgateDescriptionTable[]> {
  const { limit, offset } = paged(opts);
  return db
    .selectFrom("smellgate_description")
    .selectAll()
    .where("author_did", "=", did)
    .orderBy("indexed_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
}

// ---------------------------------------------------------------------------
// Perfume-scoped reads
// ---------------------------------------------------------------------------

export async function getReviewsForPerfume(
  db: Db,
  perfumeUri: string,
  opts?: PaginationOpts,
): Promise<SmellgateReviewTable[]> {
  const { limit, offset } = paged(opts);
  return db
    .selectFrom("smellgate_review")
    .selectAll()
    .where("perfume_uri", "=", perfumeUri)
    .orderBy("indexed_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
}

/**
 * Descriptions of a perfume with vote tallies and a score,
 * score-descending. "Score" is `up - down`, where each author
 * contributes at most one vote per description (their most recent,
 * per docs/lexicons.md). Ties break on `indexed_at DESC` so new
 * content surfaces above older content at the same score.
 *
 * The aggregation subquery builds, per description URI, the set of
 * "most recent vote per (author, subject)" and sums them into up /
 * down counts. It's a single SQL statement; the assembly in JS is
 * just attaching the aggregate to each description row.
 */
export async function getDescriptionsForPerfume(
  db: Db,
  perfumeUri: string,
  opts?: PaginationOpts,
): Promise<DescriptionWithVotes[]> {
  const { limit, offset } = paged(opts);

  const descriptions = await db
    .selectFrom("smellgate_description")
    .selectAll()
    .where("perfume_uri", "=", perfumeUri)
    .execute();
  if (descriptions.length === 0) return [];

  const subjectUris = descriptions.map((d) => d.uri);

  // Most recent vote per (author_did, subject_uri): for each
  // candidate row, require that no other vote from the same author on
  // the same subject has a strictly later indexed_at. `indexed_at` is
  // unix milliseconds; ties on the same author+subject+indexed_at are
  // vanishingly unlikely and would only arise if the dispatcher
  // indexed two vote *records* in the same millisecond from the same
  // author, which Phase 2.A's upsert path already collapses via the
  // `uri` primary key for the common "author re-votes" case.
  const tallies = await db
    .selectFrom("smellgate_vote as v")
    .select([
      "v.subject_uri",
      "v.direction",
      (eb) => eb.fn.countAll<number>().as("count"),
    ])
    .where("v.subject_uri", "in", subjectUris)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("smellgate_vote as v2")
            .select(sql<number>`1`.as("one"))
            .whereRef("v2.author_did", "=", "v.author_did")
            .whereRef("v2.subject_uri", "=", "v.subject_uri")
            .whereRef("v2.indexed_at", ">", "v.indexed_at"),
        ),
      ),
    )
    .groupBy(["v.subject_uri", "v.direction"])
    .execute();

  const tallyByUri = new Map<string, { up: number; down: number }>();
  for (const row of tallies) {
    const prev = tallyByUri.get(row.subject_uri) ?? { up: 0, down: 0 };
    const count = Number(row.count);
    if (row.direction === "up") prev.up += count;
    else if (row.direction === "down") prev.down += count;
    tallyByUri.set(row.subject_uri, prev);
  }

  const enriched: DescriptionWithVotes[] = descriptions.map((d) => {
    const t = tallyByUri.get(d.uri) ?? { up: 0, down: 0 };
    return {
      ...d,
      up_count: t.up,
      down_count: t.down,
      score: t.up - t.down,
    };
  });

  enriched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.indexed_at - a.indexed_at;
  });

  return enriched.slice(offset, offset + limit);
}

/**
 * Vote tally for a single description URI, respecting the
 * "one-vote-per-(author, subject)" rule from docs/lexicons.md. The
 * same most-recent-per-author filter as `getDescriptionsForPerfume`.
 */
export async function getVoteTally(
  db: Db,
  descriptionUri: string,
): Promise<VoteTally> {
  const rows = await db
    .selectFrom("smellgate_vote as v")
    .select(["v.direction", (eb) => eb.fn.countAll<number>().as("count")])
    .where("v.subject_uri", "=", descriptionUri)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("smellgate_vote as v2")
            .select(sql<number>`1`.as("one"))
            .whereRef("v2.author_did", "=", "v.author_did")
            .whereRef("v2.subject_uri", "=", "v.subject_uri")
            .whereRef("v2.indexed_at", ">", "v.indexed_at"),
        ),
      ),
    )
    .groupBy("v.direction")
    .execute();

  const tally: VoteTally = { up: 0, down: 0 };
  for (const row of rows) {
    const count = Number(row.count);
    if (row.direction === "up") tally.up += count;
    else if (row.direction === "down") tally.down += count;
  }
  return tally;
}

export async function getCommentsForReview(
  db: Db,
  reviewUri: string,
  opts?: PaginationOpts,
): Promise<SmellgateCommentTable[]> {
  const { limit, offset } = paged(opts);
  return db
    .selectFrom("smellgate_comment")
    .selectAll()
    .where("subject_uri", "=", reviewUri)
    .orderBy("indexed_at", "asc")
    .limit(limit)
    .offset(offset)
    .execute();
}

// ---------------------------------------------------------------------------
// Curator / submission reads
// ---------------------------------------------------------------------------

/**
 * Perfume submissions that do NOT yet have a
 * `smellgate_perfume_submission_resolution` row pointing at them.
 * LEFT JOIN + `IS NULL` on the resolution side; FIFO by
 * `indexed_at ASC` so curators work the oldest backlog first.
 */
export async function getPendingSubmissions(
  db: Db,
  opts?: PaginationOpts,
): Promise<SmellgatePerfumeSubmissionTable[]> {
  const { limit, offset } = paged(opts);
  return db
    .selectFrom("smellgate_perfume_submission as s")
    .leftJoin(
      "smellgate_perfume_submission_resolution as r",
      "r.submission_uri",
      "s.uri",
    )
    .where("r.uri", "is", null)
    .selectAll("s")
    .orderBy("s.indexed_at", "asc")
    .limit(limit)
    .offset(offset)
    .execute();
}

export async function getResolutionForSubmission(
  db: Db,
  submissionUri: string,
): Promise<SmellgatePerfumeSubmissionResolutionTable | null> {
  const row = await db
    .selectFrom("smellgate_perfume_submission_resolution")
    .selectAll()
    .where("submission_uri", "=", submissionUri)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Fetch a single submission row by URI, with its note tags attached.
 * Used by the curator approve flow when constructing the canonical
 * perfume record from the submission's fields.
 */
export async function getPerfumeSubmissionByUri(
  db: Db,
  uri: string,
): Promise<(SmellgatePerfumeSubmissionTable & { notes: string[] }) | null> {
  const row = await db
    .selectFrom("smellgate_perfume_submission")
    .selectAll()
    .where("uri", "=", uri)
    .executeTakeFirst();
  if (!row) return null;
  const noteRows = await db
    .selectFrom("smellgate_perfume_submission_note")
    .select("note")
    .where("submission_uri", "=", uri)
    .execute();
  return { ...row, notes: noteRows.map((n) => n.note) };
}

// ---------------------------------------------------------------------------
// Pending-record discovery for the rewrite mechanic (Phase 3.C).
//
// A user record (shelf_item / review / description) is "pending" when
// its `perfume_uri` does not resolve to a canonical perfume row but
// DOES resolve to a submission row — i.e. the author wrote a record
// pointing at a `com.smellgate.perfumeSubmission` URI rather than a
// `com.smellgate.perfume` URI, per docs/lexicons.md §"The submission →
// canonical flow" step 3.
//
// Pending status is computed on the fly (no schema change) by joining
// `perfume_uri` against `smellgate_perfume_submission`. The rewrite
// mechanic additionally joins against
// `smellgate_perfume_submission_resolution` to find the pending records
// that are ready to be repointed at a canonical perfume: those whose
// submission has been approved or marked duplicate, AND the resolution
// carries a non-null `perfume` strongRef. Rejections are deliberately
// excluded — on rejection the user is prompted by the UI, not rewritten
// automatically.
// ---------------------------------------------------------------------------

export interface PendingRewrite {
  /** AT-URI of the user's pending record (shelfItem / review / description). */
  recordUri: string;
  /** Content CID currently stored in the cache for the pending record. */
  recordCid: string;
  /** Submission URI the record currently points at. */
  submissionUri: string;
  /** Canonical perfume URI to rewrite to. */
  newPerfumeUri: string;
  /** Canonical perfume CID to rewrite to. */
  newPerfumeCid: string;
  /** Resolution that justified the rewrite. */
  resolutionUri: string;
  /** `"approved"` or `"duplicate"` — never `"rejected"`. */
  decision: "approved" | "duplicate";
}

async function selectPendingShelfItems(
  db: Db,
  authorDid: string,
): Promise<PendingRewrite[]> {
  const rows = await db
    .selectFrom("smellgate_shelf_item as u")
    .innerJoin(
      "smellgate_perfume_submission as s",
      "s.uri",
      "u.perfume_uri",
    )
    .innerJoin(
      "smellgate_perfume_submission_resolution as r",
      "r.submission_uri",
      "s.uri",
    )
    .where("u.author_did", "=", authorDid)
    .where("r.perfume_uri", "is not", null)
    .where("r.decision", "in", ["approved", "duplicate"])
    .select([
      "u.uri as recordUri",
      "u.cid as recordCid",
      "s.uri as submissionUri",
      "r.perfume_uri as newPerfumeUri",
      "r.perfume_cid as newPerfumeCid",
      "r.uri as resolutionUri",
      "r.decision as decision",
    ])
    .execute();
  return rows.map((r) => ({
    recordUri: r.recordUri,
    recordCid: r.recordCid,
    submissionUri: r.submissionUri,
    newPerfumeUri: r.newPerfumeUri!,
    newPerfumeCid: r.newPerfumeCid!,
    resolutionUri: r.resolutionUri,
    decision: r.decision as "approved" | "duplicate",
  }));
}

async function selectPendingReviews(
  db: Db,
  authorDid: string,
): Promise<PendingRewrite[]> {
  const rows = await db
    .selectFrom("smellgate_review as u")
    .innerJoin(
      "smellgate_perfume_submission as s",
      "s.uri",
      "u.perfume_uri",
    )
    .innerJoin(
      "smellgate_perfume_submission_resolution as r",
      "r.submission_uri",
      "s.uri",
    )
    .where("u.author_did", "=", authorDid)
    .where("r.perfume_uri", "is not", null)
    .where("r.decision", "in", ["approved", "duplicate"])
    .select([
      "u.uri as recordUri",
      "u.cid as recordCid",
      "s.uri as submissionUri",
      "r.perfume_uri as newPerfumeUri",
      "r.perfume_cid as newPerfumeCid",
      "r.uri as resolutionUri",
      "r.decision as decision",
    ])
    .execute();
  return rows.map((r) => ({
    recordUri: r.recordUri,
    recordCid: r.recordCid,
    submissionUri: r.submissionUri,
    newPerfumeUri: r.newPerfumeUri!,
    newPerfumeCid: r.newPerfumeCid!,
    resolutionUri: r.resolutionUri,
    decision: r.decision as "approved" | "duplicate",
  }));
}

async function selectPendingDescriptions(
  db: Db,
  authorDid: string,
): Promise<PendingRewrite[]> {
  const rows = await db
    .selectFrom("smellgate_description as u")
    .innerJoin(
      "smellgate_perfume_submission as s",
      "s.uri",
      "u.perfume_uri",
    )
    .innerJoin(
      "smellgate_perfume_submission_resolution as r",
      "r.submission_uri",
      "s.uri",
    )
    .where("u.author_did", "=", authorDid)
    .where("r.perfume_uri", "is not", null)
    .where("r.decision", "in", ["approved", "duplicate"])
    .select([
      "u.uri as recordUri",
      "u.cid as recordCid",
      "s.uri as submissionUri",
      "r.perfume_uri as newPerfumeUri",
      "r.perfume_cid as newPerfumeCid",
      "r.uri as resolutionUri",
      "r.decision as decision",
    ])
    .execute();
  return rows.map((r) => ({
    recordUri: r.recordUri,
    recordCid: r.recordCid,
    submissionUri: r.submissionUri,
    newPerfumeUri: r.newPerfumeUri!,
    newPerfumeCid: r.newPerfumeCid!,
    resolutionUri: r.resolutionUri,
    decision: r.decision as "approved" | "duplicate",
  }));
}

/**
 * Find all pending records for a given user, partitioned by collection.
 * Returns the three user-record collections the rewrite mechanic
 * touches. Votes/comments are out of scope — their strongRefs point at
 * descriptions/reviews, not perfumes/submissions.
 */
export async function getPendingRecordsForUser(
  db: Db,
  authorDid: string,
): Promise<{
  shelfItems: PendingRewrite[];
  reviews: PendingRewrite[];
  descriptions: PendingRewrite[];
}> {
  const [shelfItems, reviews, descriptions] = await Promise.all([
    selectPendingShelfItems(db, authorDid),
    selectPendingReviews(db, authorDid),
    selectPendingDescriptions(db, authorDid),
  ]);
  return { shelfItems, reviews, descriptions };
}
