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
 *   3. Approve a submission (writes a canonical `com.smellgate.perfume`
 *      + a `com.smellgate.perfumeSubmissionResolution` to the curator's
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
import * as com from "../lexicons/com";
import { isCurator } from "../curators";
import {
  getPendingRecordsForUser,
  getPendingSubmissions,
  getPerfumeByUri,
  getPerfumeSubmissionByUri,
  type PendingRewrite,
} from "../db/smellgate-queries";
import type {
  DatabaseSchema,
  SmellgatePerfumeSubmissionTable,
} from "../db";
import { ActionError } from "./smellgate-actions";

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

export async function listPendingSubmissionsAction(
  db: Db,
  session: OAuthSession,
): Promise<SmellgatePerfumeSubmissionTable[]> {
  requireCurator(session);
  return getPendingSubmissions(db);
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

  const lexClient = new Client(session);

  // Step 1: write the canonical perfume record to the curator's PDS,
  // copying fields from the submission. Per docs/lexicons.md, the
  // canonical record is a fresh row in the curator's repo — it is NOT
  // an edit of the user's submission record.
  const perfumeRes = await lexClient.create(com.smellgate.perfume.main, {
    name: submission.name,
    house: submission.house,
    creator: submission.creator ?? undefined,
    releaseYear: submission.release_year ?? undefined,
    notes: submission.notes,
    description: submission.description ?? undefined,
    createdAt: nowDatetime(),
  });

  // Step 2: write the resolution linking the submission to the new
  // canonical perfume. Both strongRefs live in the curator's repo.
  const resolutionRes = await lexClient.create(
    com.smellgate.perfumeSubmissionResolution.main,
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
  if (input.note !== undefined) {
    if (typeof input.note !== "string" || input.note.trim().length === 0) {
      bad("note must be a non-empty string when provided");
    }
  }
  const submission = await getPerfumeSubmissionByUri(db, input.submissionUri);
  if (!submission) notFound(`unknown submission: ${input.submissionUri}`);

  const lexClient = new Client(session);
  const resolutionRes = await lexClient.create(
    com.smellgate.perfumeSubmissionResolution.main,
    {
      submission: strongRef(submission.uri, submission.cid),
      decision: "rejected",
      note: input.note,
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

  const lexClient = new Client(session);
  const resolutionRes = await lexClient.create(
    com.smellgate.perfumeSubmissionResolution.main,
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
    | "com.smellgate.shelfItem"
    | "com.smellgate.review"
    | "com.smellgate.description",
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
    case "com.smellgate.shelfItem": {
      const v = value as {
        perfume: { uri: string; cid: string };
        acquiredAt?: string;
        bottleSizeMl?: number;
        isDecant?: boolean;
        createdAt: string;
      };
      await client.put(
        com.smellgate.shelfItem.main,
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
    case "com.smellgate.review": {
      const v = value as {
        perfume: { uri: string; cid: string };
        rating: number;
        sillage: number;
        longevity: number;
        body: string;
        createdAt: string;
      };
      await client.put(
        com.smellgate.review.main,
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
    case "com.smellgate.description": {
      const v = value as {
        perfume: { uri: string; cid: string };
        body: string;
        createdAt: string;
      };
      await client.put(
        com.smellgate.description.main,
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
      "com.smellgate.shelfItem" | "com.smellgate.review" | "com.smellgate.description",
      PendingRewrite[],
    ]
  > = [
    ["com.smellgate.shelfItem", pending.shelfItems],
    ["com.smellgate.review", pending.reviews],
    ["com.smellgate.description", pending.descriptions],
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
