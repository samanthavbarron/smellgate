/**
 * Curator-only server actions + the pending-record rewrite mechanic
 * for Phase 3.C (issue #55). These sit alongside
 * `lib/server/smellgate-actions.ts` — same `ActionError` convention,
 * same pure-function + `OAuthSession` shape — but split into their own
 * module because they have meaningfully different authorization rules
 * (curator-gated) and the rewrite mechanic is the subtle piece of this
 * PR that deserves its own file to read top-to-bottom.
 *
 * Layout:
 *
 *   1. Curator gate helpers.
 *   2. List pending submissions.
 *   3. Approve a submission (writes a canonical `app.smellgate.perfume`
 *      + a `app.smellgate.perfumeSubmissionResolution` to the curator's
 *      PDS).
 *   4. Reject a submission (writes a resolution with
 *      `decision: "rejected"`).
 *   5. Mark a submission as duplicate of an existing canonical perfume
 *      (writes a resolution with `decision: "duplicate"`).
 *   6. `rewritePendingRecords` — the user-side rewriter that fixes up
 *      a signed-in user's shelfItem / review / description records
 *      whose `perfume` strongRef still points at a submission URI
 *      after a curator has resolved the submission.
 *
 * See docs/lexicons.md §"The submission → canonical flow" for the
 * design rationale. Short version: on approval or duplicate, the
 * user's pending records are *edited* in place via `putRecord` (same
 * rkey) to repoint the strongRef at the canonical perfume. The
 * alternatives considered — hard-reject non-canonical refs, eagerly
 * copy canonical fields, or use a placeholder record — are listed in
 * the doc and were all rejected there.
 *
 * The rewrite runs as an explicit server action the login flow can
 * invoke (see `app/oauth/callback/route.ts`). Running inside the
 * callback was weighed against running on the client post-login; the
 * callback route is the first point where the server holds a usable
 * `OAuthSession`, so doing the work there means offline users get
 * their records rewritten the very next time they log in, with no
 * UI work needed (Phase 4). The rewrite is best-effort: any single
 * record's failure is logged and skipped, it does not fail the login.
 */

import { Client, type l } from "@atproto/lex";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { AtUri } from "@atproto/syntax";
import type { Kysely } from "kysely";
import * as app from "../lexicons/app";
import { isCurator } from "../curators";
import {
  getPendingRecordsForUser,
  getPendingSubmissions,
  getPerfumeByUri,
  getPerfumeSubmissionByUri,
  getResolutionForSubmission,
  searchPerfumes,
  type PendingRewrite,
} from "../db/smellgate-queries";
import { getAccountHandle } from "../db/queries";
import type {
  DatabaseSchema,
  SmellgatePerfumeSubmissionTable,
} from "../db";
import { ActionError } from "./smellgate-actions";
import { normalizeNotes, sanitizeFreeText } from "./write-guards";

export { ActionError } from "./smellgate-actions";

type Db = Kysely<DatabaseSchema>;

// ---------------------------------------------------------------------------
// Branded-string casts at the lexicon boundary. Same rationale as
// `lib/server/smellgate-actions.ts`.
// ---------------------------------------------------------------------------

function asAtUri(s: string): l.AtUriString {
  return s as unknown as l.AtUriString;
}
function asDatetime(s: string): l.DatetimeString {
  return s as unknown as l.DatetimeString;
}
function asCid(s: string): l.CidString {
  return s as unknown as l.CidString;
}
function strongRef(uri: string, cid: string) {
  return { uri: asAtUri(uri), cid: asCid(cid) };
}
function nowDatetime(): l.DatetimeString {
  return asDatetime(new Date().toISOString());
}

function bad(message: string): never {
  throw new ActionError(400, message);
}
function forbidden(message: string): never {
  throw new ActionError(403, message);
}
function notFound(message: string): never {
  throw new ActionError(404, message);
}

function requireCurator(session: OAuthSession): void {
  if (!isCurator(session.did)) {
    forbidden("curator access required");
  }
}

/**
 * Issue #138: reject a curator action if the submission has already
 * been resolved (approved / rejected / duplicate). Applied to all
 * three of approve / reject / markDuplicate so that a double-click
 * on any of those buttons can't mint a second canonical perfume or
 * stack up conflicting resolutions.
 *
 * This is best-effort — it reads from the local Tap cache which lags
 * the firehose — but it closes the common case (double-click / stale
 * UI refresh) cleanly. A stronger uniqueness constraint at the
 * lexicon / PDS level is tracked as a follow-up; see the issue body.
 */
async function requireNotAlreadyResolved(
  db: Db,
  submissionUri: string,
): Promise<void> {
  const prior = await getResolutionForSubmission(db, submissionUri);
  if (prior) {
    throw new ActionError(
      400,
      `submission already resolved as "${prior.decision}"`,
    );
  }
}

function parseRkey(uri: string): { collection: string; rkey: string } {
  try {
    const parsed = new AtUri(uri);
    return { collection: parsed.collection, rkey: parsed.rkey };
  } catch {
    bad(`invalid at-uri: ${uri}`);
  }
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface ApproveSubmissionInput {
  submissionUri: string;
}

export interface ApproveSubmissionResult {
  perfumeUri: string;
  resolutionUri: string;
}

export interface RejectSubmissionInput {
  submissionUri: string;
  note?: string;
}

export interface MarkDuplicateInput {
  submissionUri: string;
  canonicalPerfumeUri: string;
}

export interface ResolutionResult {
  resolutionUri: string;
}

export interface RewriteResult {
  /** AT-URIs of records that were successfully edited on the user's PDS. */
  rewrittenUris: string[];
  /** Records that were candidates for rewrite but failed the PDS write. */
  failedUris: string[];
}

// ---------------------------------------------------------------------------
// List pending submissions (curator-gated).
// ---------------------------------------------------------------------------

/**
 * The fully-decorated shape every pending-submissions consumer wants
 * (SSR curator page, JSON API for the CLI, any future tooling). Issue
 * #140 moved the notes + handle fan-out here so the two consumers
 * can't drift.
 *
 * Field naming mirrors the column names the SSR page already consumed
 * from the raw `SmellgatePerfumeSubmissionTable` row (`release_year`,
 * `indexed_at`, `author_did`, `created_at`) plus the derived
 * decorations (`notes`, `authorHandle`). Keeping the raw + decorated
 * fields side-by-side lets the consumer pick.
 */
export interface DecoratedPendingSubmission {
  uri: string;
  cid: string;
  authorDid: string;
  authorHandle: string | null;
  indexedAt: number;
  name: string;
  house: string;
  creator: string | null;
  releaseYear: number | null;
  description: string | null;
  rationale: string | null;
  notes: string[];
  createdAt: string;
}

export interface ListPendingSubmissionsResult {
  submissions: DecoratedPendingSubmission[];
}

export async function listPendingSubmissionsAction(
  db: Db,
  session: OAuthSession,
): Promise<ListPendingSubmissionsResult> {
  requireCurator(session);
  const rows = await getPendingSubmissions(db);

  const notesByUri = await loadNotesForSubmissions(db, rows);
  const handlesByDid = await loadHandlesForSubmissions(rows);

  const submissions: DecoratedPendingSubmission[] = rows.map((s) => ({
    uri: s.uri,
    cid: s.cid,
    authorDid: s.author_did,
    authorHandle: handlesByDid.get(s.author_did) ?? null,
    indexedAt: s.indexed_at,
    name: s.name,
    house: s.house,
    creator: s.creator,
    releaseYear: s.release_year,
    description: s.description,
    rationale: s.rationale,
    notes: notesByUri.get(s.uri) ?? [],
    createdAt: s.created_at,
  }));

  return { submissions };
}

/**
 * Batch-load note chips for a set of pending submissions. Single
 * `WHERE submission_uri IN (...)` round-trip, then group in JS.
 * Exported at module scope so the curator page's legacy callsite is
 * gone and this one implementation is canonical.
 */
async function loadNotesForSubmissions(
  db: Db,
  submissions: SmellgatePerfumeSubmissionTable[],
): Promise<Map<string, string[]>> {
  const uris = submissions.map((s) => s.uri);
  if (uris.length === 0) return new Map();
  const rows = await db
    .selectFrom("smellgate_perfume_submission_note")
    .select(["submission_uri", "note"])
    .where("submission_uri", "in", uris)
    .execute();
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const list = out.get(row.submission_uri) ?? [];
    list.push(row.note);
    out.set(row.submission_uri, list);
  }
  return out;
}

/**
 * Resolve a handle for each distinct submitter DID via
 * `getAccountHandle`, which already falls back to Tap's identity
 * resolver when the account isn't cached.
 */
async function loadHandlesForSubmissions(
  submissions: SmellgatePerfumeSubmissionTable[],
): Promise<Map<string, string | null>> {
  const dids = Array.from(new Set(submissions.map((s) => s.author_did)));
  const entries = await Promise.all(
    dids.map(async (did) => [did, await getAccountHandle(did)] as const),
  );
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Canonical-candidate search for the duplicate picker (issue #139).
//
// The curator's "Mark duplicate" flow needs a list of canonical perfume
// URIs to pick from. Before #139 the curator had to hand-paste an AT-URI
// (discovered through the URL bar + a percent-decode dance). This
// action is the server-side half of the typeahead: curator-gated,
// returns top-N candidates from `searchPerfumes`, shaped as the tight
// `CandidatePerfume` wire form so the response JSON stays small.
//
// Deliberately thin — no re-ranking, no NULL-creator hiding, nothing
// that `searchPerfumes` doesn't already do. If the underlying query
// returns zero rows, this returns `{ candidates: [] }` and the UI
// shows a "no matches; paste URI manually" hint; the existing paste-
// URI input remains the fallback.
// ---------------------------------------------------------------------------

export interface CandidatePerfume {
  uri: string;
  name: string;
  house: string;
  creator: string | null;
  releaseYear: number | null;
}

export interface ListCanonicalCandidatesInput {
  query: string;
  /** Max candidates to return. Default 5; hard-capped at 25 to keep the
   *  response small even if a client asks for too many. */
  limit?: number;
}

export interface ListCanonicalCandidatesResult {
  candidates: CandidatePerfume[];
}

const DEFAULT_CANDIDATE_LIMIT = 5;
const MAX_CANDIDATE_LIMIT = 25;

export async function listCanonicalCandidatesAction(
  db: Db,
  session: OAuthSession,
  input: ListCanonicalCandidatesInput,
): Promise<ListCanonicalCandidatesResult> {
  requireCurator(session);
  if (!input || typeof input.query !== "string") {
    bad("query is required");
  }
  const trimmed = input.query.trim();
  if (trimmed.length === 0) {
    return { candidates: [] };
  }
  const requested = input.limit ?? DEFAULT_CANDIDATE_LIMIT;
  if (!Number.isInteger(requested) || requested <= 0) {
    bad("limit must be a positive integer");
  }
  const limit = Math.min(requested, MAX_CANDIDATE_LIMIT);
  const rows = await searchPerfumes(db, trimmed, { limit });
  return {
    candidates: rows.map((r) => ({
      uri: r.uri,
      name: r.name,
      house: r.house,
      creator: r.creator,
      releaseYear: r.release_year,
    })),
  };
}

// ---------------------------------------------------------------------------
// Approve a submission.
// ---------------------------------------------------------------------------

export async function approveSubmissionAction(
  db: Db,
  session: OAuthSession,
  input: ApproveSubmissionInput,
): Promise<ApproveSubmissionResult> {
  requireCurator(session);
  if (!input || typeof input.submissionUri !== "string") {
    bad("submissionUri is required");
  }
  const submission = await getPerfumeSubmissionByUri(db, input.submissionUri);
  if (!submission) notFound(`unknown submission: ${input.submissionUri}`);

  // Issue #138: "already resolved" guard. The previous behavior
  // would happily mint a second canonical perfume on a double-click.
  // We check the cache (best-effort — it lags the firehose, but the
  // common double-click case is fully covered because the first
  // approve's resolution writes through the dispatcher before the
  // second approve's button click lands).
  await requireNotAlreadyResolved(db, input.submissionUri);

  const lexClient = new Client(session);

  // Step 1: write the canonical perfume record to the curator's PDS,
  // copying fields from the submission. Per docs/lexicons.md, the
  // canonical record is a fresh row in the curator's repo — it is NOT
  // an edit of the user's submission record.
  //
  // Defense-in-depth: re-normalize notes and re-sanitize the
  // description even though the submission itself was normalized at
  // write time. The cache row is populated by the firehose from the
  // submitter's PDS, and a malicious (or compromised) PDS could in
  // principle return a raw value that bypassed our submission-time
  // guards. Re-applying the same helpers on the approve path keeps
  // the canonical catalog clean regardless.
  const canonicalNotes = normalizeNotes(submission.notes);
  const canonicalDescription =
    submission.description !== null && submission.description !== undefined
      ? sanitizeFreeText(submission.description, "description")
      : undefined;

  const perfumeRes = await lexClient.create(app.smellgate.perfume.main, {
    name: submission.name,
    house: submission.house,
    creator: submission.creator ?? undefined,
    releaseYear: submission.release_year ?? undefined,
    notes: canonicalNotes,
    description: canonicalDescription,
    createdAt: nowDatetime(),
  });

  // Step 2: write the resolution linking the submission to the new
  // canonical perfume. Both strongRefs live in the curator's repo.
  const resolutionRes = await lexClient.create(
    app.smellgate.perfumeSubmissionResolution.main,
    {
      submission: strongRef(submission.uri, submission.cid),
      decision: "approved",
      perfume: strongRef(perfumeRes.uri, perfumeRes.cid),
      createdAt: nowDatetime(),
    },
  );

  return {
    perfumeUri: perfumeRes.uri,
    resolutionUri: resolutionRes.uri,
  };
}

// ---------------------------------------------------------------------------
// Reject a submission.
// ---------------------------------------------------------------------------

export async function rejectSubmissionAction(
  db: Db,
  session: OAuthSession,
  input: RejectSubmissionInput,
): Promise<ResolutionResult> {
  requireCurator(session);
  if (!input || typeof input.submissionUri !== "string") {
    bad("submissionUri is required");
  }
  let note: string | undefined;
  if (input.note !== undefined) {
    if (typeof input.note !== "string" || input.note.trim().length === 0) {
      bad("note must be a non-empty string when provided");
    }
    // Issue #129/#130: the rejection note is shown to the submitter,
    // so it must be sanitized at the write edge.
    note = sanitizeFreeText(input.note, "note");
  }
  const submission = await getPerfumeSubmissionByUri(db, input.submissionUri);
  if (!submission) notFound(`unknown submission: ${input.submissionUri}`);

  // Issue #138: already-resolved guard.
  await requireNotAlreadyResolved(db, input.submissionUri);

  const lexClient = new Client(session);
  const resolutionRes = await lexClient.create(
    app.smellgate.perfumeSubmissionResolution.main,
    {
      submission: strongRef(submission.uri, submission.cid),
      decision: "rejected",
      note,
      createdAt: nowDatetime(),
    },
  );
  return { resolutionUri: resolutionRes.uri };
}

// ---------------------------------------------------------------------------
// Mark as duplicate.
// ---------------------------------------------------------------------------

export async function markDuplicateAction(
  db: Db,
  session: OAuthSession,
  input: MarkDuplicateInput,
): Promise<ResolutionResult> {
  requireCurator(session);
  if (!input || typeof input.submissionUri !== "string") {
    bad("submissionUri is required");
  }
  if (typeof input.canonicalPerfumeUri !== "string") {
    bad("canonicalPerfumeUri is required");
  }
  const submission = await getPerfumeSubmissionByUri(db, input.submissionUri);
  if (!submission) notFound(`unknown submission: ${input.submissionUri}`);
  const canonical = await getPerfumeByUri(db, input.canonicalPerfumeUri);
  if (!canonical) {
    notFound(`unknown canonical perfume: ${input.canonicalPerfumeUri}`);
  }

  // Issue #138: already-resolved guard.
  await requireNotAlreadyResolved(db, input.submissionUri);

  const lexClient = new Client(session);
  const resolutionRes = await lexClient.create(
    app.smellgate.perfumeSubmissionResolution.main,
    {
      submission: strongRef(submission.uri, submission.cid),
      decision: "duplicate",
      perfume: strongRef(canonical.uri, canonical.cid),
      createdAt: nowDatetime(),
    },
  );
  return { resolutionUri: resolutionRes.uri };
}

// ---------------------------------------------------------------------------
// Rewrite mechanic.
//
// Reads the cache for (record, submission, resolution) triples that
// belong to the signed-in user and whose resolution is `approved` or
// `duplicate` (never `rejected` — rejections are handled by the UI).
// For each triple, fetches the current record body from the user's
// PDS, replaces the `perfume` strongRef with the canonical one, and
// writes it back with `putRecord` at the same rkey. The original `tid`
// and the rest of the record body are preserved — this is an edit,
// not a delete-and-recreate.
//
// The Tap dispatcher's `create` and `update` handlers share the same
// upsert path (`ON CONFLICT (uri) DO UPDATE`), so the edit will
// naturally refresh the cache row when the firehose delivers the
// `update` event. In tests we don't have a live firehose; tests
// either re-dispatch a synthetic `update` event or re-read the PDS
// directly.
// ---------------------------------------------------------------------------

/**
 * Rewrite one candidate pending record. Fetches the live record from
 * the user's PDS, swaps the `perfume` strongRef, and puts it back.
 * Only the `perfume` field changes — everything else is preserved.
 *
 * Per-collection because the record schemas are different; we use
 * the generated lexicon `main` for each to get type-safe `put`.
 */
async function rewriteOne(
  client: Client,
  collection:
    | "app.smellgate.shelfItem"
    | "app.smellgate.review"
    | "app.smellgate.description",
  candidate: PendingRewrite,
): Promise<void> {
  const { collection: recCollection, rkey } = parseRkey(candidate.recordUri);
  if (recCollection !== collection) {
    throw new Error(
      `rewrite collection mismatch: expected ${collection}, got ${recCollection}`,
    );
  }

  // Fetch the live record from the user's PDS. We deliberately read
  // via the low-level `getRecord` (not the typed `client.get`) because
  // we need the raw value as a plain object to preserve fields we
  // don't otherwise know about.
  const fetched = await client.getRecord(collection, rkey);
  const value = fetched.body.value as Record<string, unknown> & {
    perfume?: unknown;
  };

  const newPerfume = {
    uri: candidate.newPerfumeUri,
    cid: candidate.newPerfumeCid,
  };

  switch (collection) {
    case "app.smellgate.shelfItem": {
      const v = value as {
        perfume: { uri: string; cid: string };
        acquiredAt?: string;
        bottleSizeMl?: number;
        isDecant?: boolean;
        createdAt: string;
      };
      await client.put(
        app.smellgate.shelfItem.main,
        {
          perfume: strongRef(newPerfume.uri, newPerfume.cid),
          acquiredAt:
            v.acquiredAt !== undefined ? asDatetime(v.acquiredAt) : undefined,
          bottleSizeMl: v.bottleSizeMl,
          isDecant: v.isDecant,
          createdAt: asDatetime(v.createdAt),
        },
        { rkey },
      );
      return;
    }
    case "app.smellgate.review": {
      const v = value as {
        perfume: { uri: string; cid: string };
        rating: number;
        sillage: number;
        longevity: number;
        body: string;
        createdAt: string;
      };
      await client.put(
        app.smellgate.review.main,
        {
          perfume: strongRef(newPerfume.uri, newPerfume.cid),
          rating: v.rating,
          sillage: v.sillage,
          longevity: v.longevity,
          body: v.body,
          createdAt: asDatetime(v.createdAt),
        },
        { rkey },
      );
      return;
    }
    case "app.smellgate.description": {
      const v = value as {
        perfume: { uri: string; cid: string };
        body: string;
        createdAt: string;
      };
      await client.put(
        app.smellgate.description.main,
        {
          perfume: strongRef(newPerfume.uri, newPerfume.cid),
          body: v.body,
          createdAt: asDatetime(v.createdAt),
        },
        { rkey },
      );
      return;
    }
  }
}

/**
 * Rewrite all the signed-in user's pending records that are now
 * resolvable via an approved or duplicate resolution. Best-effort:
 * individual failures do not halt the batch.
 *
 * Returns the set of records that were actually edited, and the set
 * that were candidates but failed. A record is only a candidate if
 * it currently lives in the cache pointing at a submission URI that
 * has a non-null `perfume` on its resolution — rejections are not
 * candidates at all.
 *
 * Cache-lag caveat on first login (#63): the pending-set query reads
 * from the local Tap read cache. If a curator writes a resolution
 * seconds before the user logs in, the firehose event may not have
 * been indexed yet — the resolution row is absent from the cache, so
 * the rewrite query returns nothing and the user's records remain
 * pending. This is deliberately unfixed: no retry loop, no "wait for
 * event" polling. The next login recomputes the pending set from the
 * same cache and, by that time, the resolution will have been
 * indexed, so the rewrite lands on the second attempt. The cost of a
 * single extra login vs. the complexity of a retry loop tilts clearly
 * toward "just wait for the next login". See docs/lexicons.md §"The
 * submission → canonical flow" step 6 for the full flow.
 */
export async function rewritePendingRecords(
  db: Db,
  session: OAuthSession,
): Promise<RewriteResult> {
  const pending = await getPendingRecordsForUser(db, session.did);
  const client = new Client(session);
  const rewrittenUris: string[] = [];
  const failedUris: string[] = [];

  const groups: Array<
    [
      "app.smellgate.shelfItem" | "app.smellgate.review" | "app.smellgate.description",
      PendingRewrite[],
    ]
  > = [
    ["app.smellgate.shelfItem", pending.shelfItems],
    ["app.smellgate.review", pending.reviews],
    ["app.smellgate.description", pending.descriptions],
  ];

  for (const [collection, candidates] of groups) {
    for (const candidate of candidates) {
      try {
        await rewriteOne(client, collection, candidate);
        rewrittenUris.push(candidate.recordUri);
      } catch (err) {
        // Best-effort: log and continue. The next login will try again.
        // eslint-disable-next-line no-console
        console.warn(
          `rewritePendingRecords: failed to rewrite ${candidate.recordUri}:`,
          err,
        );
        failedUris.push(candidate.recordUri);
      }
    }
  }

  return { rewrittenUris, failedUris };
}
