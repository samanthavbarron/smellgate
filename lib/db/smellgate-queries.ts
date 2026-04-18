/**
 * Kysely query layer for the `app.smellgate.*` read cache (Phase 2.B).
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

/**
 * Build the "most recent vote per (author, subject)" tally map for a
 * set of description URIs. Shared by `getDescriptionsForPerfume` and
 * `getUserDescriptions`. Returns an empty map if the input is empty
 * so callers don't have to special-case it.
 *
 * Implementation: for each candidate vote row, require that no other
 * vote from the same author on the same subject has a strictly later
 * `indexed_at`. This matches the Phase 2.B rule from
 * docs/lexicons.md: "One vote per (user, description) is enforced at
 * the read layer, keeping each author's most recent vote".
 */
async function loadVoteTallies(
  db: Db,
  subjectUris: string[],
): Promise<Map<string, { up: number; down: number }>> {
  const byUri = new Map<string, { up: number; down: number }>();
  if (subjectUris.length === 0) return byUri;

  const rows = await db
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

  for (const row of rows) {
    const prev = byUri.get(row.subject_uri) ?? { up: 0, down: 0 };
    const count = Number(row.count);
    if (row.direction === "up") prev.up += count;
    else if (row.direction === "down") prev.down += count;
    byUri.set(row.subject_uri, prev);
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

/**
 * Most recently indexed canonical perfumes, newest first. Powers the
 * home page's "recent perfumes" grid (Phase 4.A). `indexed_at` — not
 * the author-controlled `created_at` — is the right ordering: it
 * reflects when our cache learned about the record, which is what the
 * "recent" section actually means to a visitor.
 */
export async function getRecentPerfumes(
  db: Db,
  opts?: PaginationOpts,
): Promise<PerfumeWithNotes[]> {
  const { limit, offset } = paged(opts);
  const perfumes = await db
    .selectFrom("smellgate_perfume")
    .selectAll()
    .orderBy("indexed_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
  return attachNotes(db, perfumes);
}

/**
 * A review bundled with a thin slice of its perfume, for list views
 * that need to show the perfume name alongside each review without
 * round-tripping per row. `perfume` is null when the referenced
 * perfume row isn't in the cache yet (firehose ordering is not
 * dependency ordering — see smellgate-queries.ts header comment).
 */
export type ReviewWithPerfume = SmellgateReviewTable & {
  perfume: { uri: string; name: string; house: string } | null;
};

/**
 * Most recently indexed reviews, newest first. Each review is returned
 * with a (uri, name, house) slice of its perfume so the home page can
 * show "<perfume name> — <house>" without an N+1. Matches the shape
 * used by `getUserShelf` for consistency.
 */
export async function getRecentReviews(
  db: Db,
  opts?: PaginationOpts,
): Promise<ReviewWithPerfume[]> {
  const { limit, offset } = paged(opts);
  const reviews = await db
    .selectFrom("smellgate_review")
    .selectAll()
    .orderBy("indexed_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
  if (reviews.length === 0) return [];

  const perfumeUris = Array.from(new Set(reviews.map((r) => r.perfume_uri)));
  const perfumeRows = await db
    .selectFrom("smellgate_perfume")
    .select(["uri", "name", "house"])
    .where("uri", "in", perfumeUris)
    .execute();
  const byUri = new Map(perfumeRows.map((p) => [p.uri, p]));

  return reviews.map((r) => ({
    ...r,
    perfume: byUri.get(r.perfume_uri) ?? null,
  }));
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

/**
 * Case-insensitive substring search over `smellgate_perfume.name` and
 * `smellgate_perfume.house` (Phase 4.F, issue #71).
 *
 * Implementation notes:
 *
 * - Matches are case-insensitive via `LOWER(col) LIKE LOWER(?)`. We do
 *   not rely on SQLite's `PRAGMA case_sensitive_like` because that's a
 *   connection-wide flag and we don't want to perturb other queries.
 * - The user's query is bound as a parameter; we never concatenate it
 *   into SQL. `%` and `_` inside the user input are escaped with a
 *   literal backslash so they behave as plain characters, and the
 *   `LIKE ... ESCAPE '\\'` clause tells SQLite about our escape char.
 * - LIKE `%query%` can't use the `name` / `house` btree indexes — this
 *   is a table scan. Fine for the current small cache; won't scale
 *   past ~10K perfumes without FTS. Deliberately not implementing FTS
 *   in this phase.
 * - Empty / whitespace-only queries short-circuit to `[]` so we never
 *   accidentally LIKE `%%` and return the whole catalog.
 * - Ordering is `name ASC` for deterministic output; no relevance
 *   scoring.
 */
export async function searchPerfumes(
  db: Db,
  query: string,
  opts?: PaginationOpts,
): Promise<PerfumeWithNotes[]> {
  const { limit, offset } = paged(opts);
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  // Escape LIKE metacharacters so a user searching for "50%" doesn't
  // get wildcard behaviour. Backslash is the escape char declared in
  // the ESCAPE clause below.
  const escaped = trimmed
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  const pattern = `%${escaped.toLowerCase()}%`;

  const perfumes = await db
    .selectFrom("smellgate_perfume")
    .selectAll()
    .where(
      sql<boolean>`lower(name) like ${pattern} escape '\\' or lower(house) like ${pattern} escape '\\'`,
    )
    .orderBy("name", "asc")
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

/**
 * Descriptions authored by a user, newest-first, each enriched with
 * up/down/score. Shares the "most recent vote per (author, subject)"
 * dedupe rule with `getDescriptionsForPerfume` via `loadVoteTallies`.
 *
 * The ordering here is `indexed_at DESC` (a chronological feed on the
 * profile page), NOT `score DESC` — a profile section is a list of
 * what *this* user wrote, not a community ranking, so newest-first is
 * the intuitive order. `getDescriptionsForPerfume` sorts by score
 * because the consumer is a ranked list of community takes on one
 * perfume.
 */
export async function getUserDescriptions(
  db: Db,
  did: string,
  opts?: PaginationOpts,
): Promise<DescriptionWithVotes[]> {
  const { limit, offset } = paged(opts);
  const descriptions = await db
    .selectFrom("smellgate_description")
    .selectAll()
    .where("author_did", "=", did)
    .orderBy("indexed_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
  if (descriptions.length === 0) return [];
  const tallyByUri = await loadVoteTallies(
    db,
    descriptions.map((d) => d.uri),
  );
  return descriptions.map((d) => {
    const t = tallyByUri.get(d.uri) ?? { up: 0, down: 0 };
    return { ...d, up_count: t.up, down_count: t.down, score: t.up - t.down };
  });
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
 * Fetch a single review row by AT-URI. Matches the shape of
 * `getPerfumeByUri`: returns `null` when the review isn't in the
 * cache. Used by the comment composer page to recover the review's
 * parent perfume so it can render a context header and compute the
 * redirect target after post.
 */
export async function getReviewByUri(
  db: Db,
  uri: string,
): Promise<SmellgateReviewTable | null> {
  const row = await db
    .selectFrom("smellgate_review")
    .selectAll()
    .where("uri", "=", uri)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Descriptions of a perfume with vote tallies and a score,
 * score-descending. "Score" is `up - down`, where each author
 * contributes at most one vote per description (their most recent,
 * per docs/lexicons.md). Ties break on `indexed_at DESC` so new
 * content surfaces above older content at the same score.
 *
 * Sorting + pagination happen in SQL — we can't fetch every
 * description for a perfume just to JS-sort-and-slice. To do that we
 * need the up/down counts in the same statement as the description
 * rows, so the server can `ORDER BY score DESC, indexed_at DESC
 * LIMIT ? OFFSET ?`.
 *
 * The aggregation preserves the "one vote per (author, subject), most
 * recent wins" rule from docs/lexicons.md. The shape is identical to
 * `loadVoteTallies`: a correlated `NOT EXISTS` against a `v2` alias
 * filters out every vote row that is not the latest from its author
 * for its subject. We then `GROUP BY subject_uri, direction` and
 * pivot up/down at the SQL layer via `SUM(CASE WHEN direction = 'up'
 * THEN count ELSE 0 END)` so the outer query has a single score
 * column to sort on.
 */
export async function getDescriptionsForPerfume(
  db: Db,
  perfumeUri: string,
  opts?: PaginationOpts,
): Promise<DescriptionWithVotes[]> {
  const { limit, offset } = paged(opts);

  // Subquery: for each description URI, compute the deduped up/down
  // tallies. Same correlated NOT EXISTS pattern used by
  // `loadVoteTallies` — CRITICAL, don't replace this with a naive
  // COUNT(*) or we lose the "most recent vote per author" rule.
  const votesAgg = db
    .selectFrom("smellgate_vote as v")
    .select([
      "v.subject_uri as subject_uri",
      sql<number>`sum(case when v.direction = 'up' then 1 else 0 end)`.as(
        "up_count",
      ),
      sql<number>`sum(case when v.direction = 'down' then 1 else 0 end)`.as(
        "down_count",
      ),
    ])
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
    .groupBy("v.subject_uri");

  const rows = await db
    .selectFrom("smellgate_description as d")
    .leftJoin(votesAgg.as("vt"), "vt.subject_uri", "d.uri")
    .where("d.perfume_uri", "=", perfumeUri)
    .select((eb) => [
      "d.uri",
      "d.cid",
      "d.author_did",
      "d.indexed_at",
      "d.perfume_uri",
      "d.perfume_cid",
      "d.body",
      "d.created_at",
      eb.fn.coalesce("vt.up_count", sql<number>`0`).as("up_count"),
      eb.fn.coalesce("vt.down_count", sql<number>`0`).as("down_count"),
      sql<number>`coalesce(vt.up_count, 0) - coalesce(vt.down_count, 0)`.as(
        "score",
      ),
    ])
    .orderBy("score", "desc")
    .orderBy("d.indexed_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();

  return rows.map((r) => ({
    uri: r.uri,
    cid: r.cid,
    author_did: r.author_did,
    indexed_at: r.indexed_at,
    perfume_uri: r.perfume_uri,
    perfume_cid: r.perfume_cid,
    body: r.body,
    created_at: r.created_at,
    up_count: Number(r.up_count),
    down_count: Number(r.down_count),
    score: Number(r.score),
  }));
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

/**
 * Batch-fetch comments for many review URIs in a single query.
 * Returns a Map keyed by review URI → comment rows (oldest-first
 * within each review, matching `getCommentsForReview`). Review URIs
 * with no comments are NOT present in the map — callers should
 * default to `[]`.
 *
 * This replaces the `Promise.all(reviews.map(getCommentsForReview))`
 * N+1 pattern on the perfume detail page. One `WHERE subject_uri IN
 * (...)` query, grouped client-side. Intentionally does not take
 * `PaginationOpts`: "all comments for the first page of reviews" is
 * the only consumer and the overall output is already bounded by the
 * review-page pagination upstream.
 */
export async function getCommentsForReviews(
  db: Db,
  reviewUris: string[],
): Promise<Map<string, SmellgateCommentTable[]>> {
  const byReview = new Map<string, SmellgateCommentTable[]>();
  if (reviewUris.length === 0) return byReview;
  const rows = await db
    .selectFrom("smellgate_comment")
    .selectAll()
    .where("subject_uri", "in", reviewUris)
    .orderBy("indexed_at", "asc")
    .execute();
  for (const row of rows) {
    const arr = byReview.get(row.subject_uri);
    if (arr) arr.push(row);
    else byReview.set(row.subject_uri, [row]);
  }
  return byReview;
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
// pointing at a `app.smellgate.perfumeSubmission` URI rather than a
// `app.smellgate.perfume` URI, per docs/lexicons.md §"The submission →
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

/**
 * The three user-record tables the rewrite mechanic walks. Each is
 * joined against `smellgate_perfume_submission` and
 * `smellgate_perfume_submission_resolution` with the same shape — the
 * only thing that varies is which table supplies the `uri` / `cid` /
 * `author_did` / `perfume_uri` columns. Factored into a single helper
 * to keep the three `selectPending*` entry points from diverging
 * (#64).
 *
 * All three user tables (`smellgate_shelf_item`, `smellgate_review`,
 * `smellgate_description`) carry the same join-relevant columns
 * (`uri`, `cid`, `author_did`, `perfume_uri`) with matching types —
 * see `lib/db/index.ts`. We build the Kysely query once, parameterized
 * by table name. Per-table column types come out as a union in the
 * typed query builder, which Kysely has no trouble resolving because
 * every referenced column resolves to the same type on every branch
 * of the union.
 */
type PendingUserTable =
  | "smellgate_shelf_item"
  | "smellgate_review"
  | "smellgate_description";

async function selectPendingFrom(
  db: Db,
  table: PendingUserTable,
  authorDid: string,
): Promise<PendingRewrite[]> {
  // Cast the Kysely schema so `selectFrom(table)` accepts the
  // runtime-determined table name against a narrowed "shape that all
  // three tables share". This is still fully type-checked: the
  // columns we reference below (`u.uri`, `u.cid`, `u.author_did`,
  // `u.perfume_uri`) exist on all three tables and have identical
  // types, so the single query body covers every concrete call.
  type UserShape = {
    uri: string;
    cid: string;
    author_did: string;
    perfume_uri: string;
  };
  type NarrowedDb = Kysely<
    Omit<DatabaseSchema, PendingUserTable> & Record<PendingUserTable, UserShape>
  >;

  const rows = await (db as unknown as NarrowedDb)
    .selectFrom(`${table} as u`)
    .innerJoin("smellgate_perfume_submission as s", "s.uri", "u.perfume_uri")
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
    selectPendingFrom(db, "smellgate_shelf_item", authorDid),
    selectPendingFrom(db, "smellgate_review", authorDid),
    selectPendingFrom(db, "smellgate_description", authorDid),
  ]);
  return { shelfItems, reviews, descriptions };
}
