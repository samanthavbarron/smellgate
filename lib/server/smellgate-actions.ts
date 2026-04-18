/**
 * OAuth-gated server-action implementations for `app.smellgate.*` writes
 * (issue #54 / Phase 3.B).
 *
 * Each function takes:
 *   - a Kysely cache handle (used to validate strongRef targets — we
 *     refuse to let a user write a record that points at a perfume /
 *     description / review URI we have never seen),
 *   - an `OAuthSession` from `@atproto/oauth-client-node` (the user's
 *     existing logged-in session, exactly the thing
 *     `lib/auth/session.ts#getSession` returns),
 *   - a structured input object,
 * and returns `{ uri }` on success or throws an `ActionError` whose
 * `status` field is the HTTP status the route handler should respond
 * with.
 *
 * Why this shape rather than wiring directly into Next.js route handlers:
 *
 * - Integration tests need to hit the same code path as production, but
 *   driving Next's full route runtime in-process is awkward. By
 *   separating "what does the action do" from "how does the route
 *   handler get a session", the route handlers stay one-line wrappers
 *   around `getSession()` and the tests can call the action functions
 *   directly with a real `OAuthSession` produced by the real OAuth flow.
 * - The pure-function shape also makes the validation rules trivially
 *   unit-testable in the future without spinning up a PDS.
 *
 * Validation rules per action are documented inline. The ranges /
 * lengths intentionally mirror what the lexicon's `$safeParse` would
 * enforce on the way back in via the Tap dispatcher — that's belt and
 * braces, but failing fast at write time gives the user a real 4xx
 * instead of a silent firehose drop.
 */

import { Client, type l } from "@atproto/lex";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { AtUri } from "@atproto/syntax";
import type { Kysely } from "kysely";
import * as app from "../lexicons/app";
import {
  getPerfumeByUri,
  getResolutionForSubmission,
} from "../db/smellgate-queries";
import type { DatabaseSchema } from "../db";
import { countGraphemes } from "../graphemes";
import {
  normalizeNotes,
  requireBoundedIdentifier,
  requireReleaseYear,
  sanitizeFreeText,
} from "./write-guards";

type Db = Kysely<DatabaseSchema>;

/**
 * The lexicons in `lib/lexicons/app/smellgate/*.defs.ts` use branded
 * types (`l.AtUriString`, `l.DatetimeString`, `l.CidString`) on
 * format-typed fields. Plain `string`s coming from request bodies and
 * cache rows do not satisfy those brands, so we cast at the boundary.
 *
 * The actual format validation still happens in two places:
 *   1. our own input validation (range / length / non-empty), and
 *   2. the lexicon `$safeParse` on the way back in via Tap (which
 *      enforces format strictly).
 *
 * The brands exist to keep TS callers from passing arbitrary strings
 * around the lexicon API; here, the cache CID is already a real CID
 * and the AT-URI is already a real AT-URI by construction (we read
 * them out of `smellgate_*` rows that the dispatcher only writes after
 * its own `$safeParse`).
 */
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

/**
 * Error thrown by an action when the request is malformed or the
 * referenced target doesn't exist. The route handler maps `status` to
 * the HTTP response code. Anything else (network errors, PDS rejecting
 * the write) bubbles up as a 500.
 */
export class ActionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ActionError";
  }
}

function bad(message: string): never {
  throw new ActionError(400, message);
}

function notFound(message: string): never {
  throw new ActionError(404, message);
}

function isFiniteInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n);
}

function isNonEmptyString(s: unknown, max: number): s is string {
  return typeof s === "string" && s.trim().length > 0 && s.length <= max;
}

/**
 * Look up a description in the cache, returning its CID for strongRef
 * construction. Defined locally rather than in `lib/db/smellgate-queries.ts`
 * because that module is read-only at this phase (Phase 2.B). One row,
 * one column — kept here so the action layer is self-contained.
 */
async function getDescriptionCid(
  db: Db,
  uri: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("smellgate_description")
    .select("cid")
    .where("uri", "=", uri)
    .executeTakeFirst();
  return row?.cid ?? null;
}

async function getReviewCid(db: Db, uri: string): Promise<string | null> {
  const row = await db
    .selectFrom("smellgate_review")
    .select("cid")
    .where("uri", "=", uri)
    .executeTakeFirst();
  return row?.cid ?? null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AddToShelfInput {
  perfumeUri: string;
  acquiredAt?: string;
  bottleSizeMl?: number;
  isDecant?: boolean;
}

export interface PostReviewInput {
  perfumeUri: string;
  rating: number;
  sillage: number;
  longevity: number;
  body: string;
}

export interface PostDescriptionInput {
  perfumeUri: string;
  body: string;
}

export interface VoteOnDescriptionInput {
  descriptionUri: string;
  direction: "up" | "down";
}

export interface CommentOnReviewInput {
  reviewUri: string;
  body: string;
}

export interface SubmitPerfumeInput {
  name: string;
  house: string;
  creator?: string;
  releaseYear?: number;
  notes: string[];
  description?: string;
  rationale?: string;
}

export interface ActionResult {
  uri: string;
}

/**
 * Result shape for `submitPerfumeAction`. Includes the normalized
 * `notes[]` so the UI can show the submitter what got stored — per
 * issue #128, silent normalization without echo is almost as bad as
 * no normalization at all. Also includes the echoed submission record
 * (per issue #111/#124) so the UI can confirm the stored values, plus
 * `status`/`message` so clients know this is pending curator review
 * rather than live.
 *
 * `idempotent: true` indicates the request matched an existing pending
 * submission from the same submitter (same name + house, case-folded).
 * No new record was written; `uri` points at the existing one. See
 * issue #126.
 */
export interface SubmitPerfumeResult {
  uri: string;
  status: "pending_review";
  message: string;
  idempotent?: boolean;
  record: {
    name: string;
    house: string;
    creator?: string;
    releaseYear?: number;
    notes: string[];
    description?: string;
    rationale?: string;
    createdAt: string;
  };
  /** @deprecated use `record` — kept for backwards compatibility with #128. */
  normalized: {
    notes: string[];
    description?: string;
    rationale?: string;
  };
}

/**
 * Result shape for `addToShelfAction`. Echoes the persisted record so
 * the client can confirm the optional fields landed (per issue #119).
 */
export interface AddToShelfResult {
  uri: string;
  record: {
    perfumeUri: string;
    bottleSizeMl?: number;
    isDecant?: boolean;
    acquiredAt?: string;
    createdAt: string;
  };
}

export interface PostReviewResult {
  uri: string;
  record: {
    perfumeUri: string;
    rating: number;
    sillage: number;
    longevity: number;
    body: string;
    createdAt: string;
  };
}

export interface PostDescriptionResult {
  uri: string;
  record: {
    perfumeUri: string;
    body: string;
    createdAt: string;
  };
}

export interface VoteOnDescriptionResult {
  uri: string;
  record: {
    descriptionUri: string;
    direction: "up" | "down";
    createdAt: string;
  };
}

export interface CommentOnReviewResult {
  uri: string;
  record: {
    reviewUri: string;
    body: string;
    createdAt: string;
  };
}

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    bad(`${name} is required`);
  }
  return value;
}

function requireDatetime(
  value: unknown,
  name: string,
): l.DatetimeString | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") bad(`${name} must be an ISO datetime string`);
  // Permissive: rely on the lexicon's `$safeParse` for the strict format
  // check on the inbound side. We just refuse the obviously wrong shapes.
  if (Number.isNaN(Date.parse(value))) {
    bad(`${name} must be a valid datetime`);
  }
  return asDatetime(value);
}

function requireIntInRange(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (!isFiniteInt(value) || value < min || value > max) {
    bad(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Issue #132: distinguish "you passed an AT-URI of the wrong kind"
 * from "you passed a valid-shape perfume AT-URI that we've never
 * seen." Both had collapsed into an HTTP 404 "unknown perfume", which
 * actively misleads first-time submitters who try to review their own
 * pending submission — the server parses the URI, sees the collection
 * is `app.smellgate.perfumeSubmission`, and could easily say so.
 *
 * Reviews / descriptions / shelf items ONLY make sense against an
 * approved catalog perfume (`app.smellgate.perfume`). If the caller
 * passed a submission URI, we explain that it's still pending curator
 * approval. Any other collection gets a generic "wrong kind of URI"
 * 400 so a stray typo (`...review/abc`) doesn't lie about approval
 * state.
 */
function requirePerfumeCollection(uri: string): void {
  let collection: string;
  try {
    collection = new AtUri(uri).collection;
  } catch {
    bad(`invalid AT-URI: ${uri}`);
  }
  if (collection === "app.smellgate.perfume") return;
  if (collection === "app.smellgate.perfumeSubmission") {
    bad(
      "cannot review a pending submission — reviews are only valid for " +
        "approved catalog perfumes (app.smellgate.perfume). This " +
        "submission is still pending curator approval.",
    );
  }
  bad(
    `expected an app.smellgate.perfume URI, got a ${collection} URI — ` +
      "only approved catalog perfumes accept shelf / review / description writes.",
  );
}

async function requirePerfumeInCache(
  db: Db,
  uri: string,
): Promise<{ uri: l.AtUriString; cid: l.CidString }> {
  if (!isNonEmptyString(uri, 8192)) bad("perfumeUri is required");
  // Reject wrong-collection URIs BEFORE the cache miss, so submission
  // URIs get the clearer message instead of "unknown perfume". See
  // `requirePerfumeCollection` for the wording rationale (#132).
  requirePerfumeCollection(uri);
  const row = await getPerfumeByUri(db, uri);
  if (!row) notFound(`unknown perfume: ${uri}`);
  return strongRef(row.uri, row.cid);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Maximum bottle size we accept on a shelf entry. Commercial perfume
 * bottles top out well under a litre (Creed Aventus caps at 500ml;
 * decants can go smaller). 1000ml is a generous ceiling that rejects
 * obvious nonsense (`999999`) without false-positiving a real large
 * bottle. Chosen per issue #119. Enforced at the write edge since the
 * lexicon itself has no bounds — the value is just `integer`.
 */
const MAX_BOTTLE_SIZE_ML = 1000;

/**
 * Write a `app.smellgate.shelfItem` record to the user's PDS.
 *
 * Validation:
 * - `perfumeUri` must resolve to a known perfume in the cache.
 * - `acquiredAt`, when present, must parse as a date.
 * - `bottleSizeMl`, when present, must be a positive integer within
 *   `(0, MAX_BOTTLE_SIZE_ML]` (issue #119).
 * - `isDecant`, when present, must be a boolean.
 *
 * Idempotence (issue #110): before creating, scan the user's own PDS
 * for existing `app.smellgate.shelfItem` records pointing at the same
 * perfume URI. If any exist, delete them first. This mirrors the
 * duplicate-vote guard (#135) and chooses "replace, not 409" so that a
 * user re-adding with different bottleSizeMl / isDecant gets the new
 * metadata rather than a conflict. The scan is capped at 100 records
 * per the same precedent — a user with >100 prior shelf items who also
 * happens to have an older stray on the same perfume would fall
 * through; acceptable v1 behaviour given shelves are small in practice.
 */
export async function addToShelfAction(
  db: Db,
  session: OAuthSession,
  input: AddToShelfInput,
): Promise<AddToShelfResult> {
  const target = await requirePerfumeInCache(db, input.perfumeUri);

  const acquiredAt = requireDatetime(input.acquiredAt, "acquiredAt");
  let bottleSizeMl: number | undefined;
  if (input.bottleSizeMl !== undefined) {
    if (!isFiniteInt(input.bottleSizeMl) || input.bottleSizeMl <= 0) {
      bad("bottleSizeMl must be a positive integer");
    }
    if (input.bottleSizeMl > MAX_BOTTLE_SIZE_ML) {
      bad(`bottleSizeMl must be ≤ ${MAX_BOTTLE_SIZE_ML}`);
    }
    bottleSizeMl = input.bottleSizeMl;
  }
  let isDecant: boolean | undefined;
  if (input.isDecant !== undefined) {
    if (typeof input.isDecant !== "boolean") bad("isDecant must be a boolean");
    isDecant = input.isDecant;
  }

  const lexClient = new Client(session);

  // Issue #110: idempotent shelf-add. Scan the user's own PDS for
  // prior shelfItem records referencing the same perfume and delete
  // them before creating a fresh one. Mirrors the duplicate-vote
  // guard in `voteOnDescriptionAction`. We use the raw
  // listRecords/deleteRecord XRPC endpoints rather than the lexicon
  // client because we need the record URIs back out of listRecords,
  // which the typed client wraps somewhat differently.
  //
  // "Replace, not 409": re-adding the same perfume is a normal user
  // action (updating bottle size, flipping the decant flag) and
  // should succeed, just without accumulating records. The new URI
  // returned is the surviving one.
  //
  // Fail-open on listRecords errors — the PDS write is still the
  // authoritative action and a transient read hiccup shouldn't block
  // a shelf add. The worst case is a single duplicate from the race
  // window, which the next successful add will clean up.
  try {
    const listUrl =
      `/xrpc/com.atproto.repo.listRecords` +
      `?repo=${encodeURIComponent(session.did)}` +
      `&collection=app.smellgate.shelfItem` +
      `&limit=100`;
    const listRes = await session.fetchHandler(listUrl, { method: "GET" });
    if (listRes.ok) {
      const body = (await listRes.json()) as {
        records: {
          uri: string;
          value: { perfume?: { uri?: string } };
        }[];
      };
      for (const rec of body.records) {
        if (rec.value?.perfume?.uri === input.perfumeUri) {
          const { rkey } = new AtUri(rec.uri);
          const delBody = {
            repo: session.did,
            collection: "app.smellgate.shelfItem",
            rkey,
          };
          await session.fetchHandler(`/xrpc/com.atproto.repo.deleteRecord`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(delBody),
          });
        }
      }
    }
  } catch (err) {
    console.warn(
      `addToShelfAction: failed to clean up prior shelf items for ${input.perfumeUri}:`,
      err,
    );
  }

  const createdAt = nowDatetime();
  const res = await lexClient.create(app.smellgate.shelfItem.main, {
    perfume: target,
    acquiredAt,
    bottleSizeMl,
    isDecant,
    createdAt,
  });
  return {
    uri: res.uri,
    record: {
      perfumeUri: input.perfumeUri,
      ...(bottleSizeMl !== undefined ? { bottleSizeMl } : {}),
      ...(isDecant !== undefined ? { isDecant } : {}),
      ...(acquiredAt !== undefined ? { acquiredAt: acquiredAt as unknown as string } : {}),
      createdAt: createdAt as unknown as string,
    },
  };
}

/**
 * Write a `app.smellgate.review` record to the user's PDS.
 *
 * Validation:
 * - `perfumeUri` must resolve in the cache.
 * - `rating` integer in [1, 10].
 * - `sillage` integer in [1, 5].
 * - `longevity` integer in [1, 5].
 * - `body` non-empty, ≤ 15000 graphemes (counted with `Intl.Segmenter`
 *   so we agree with the lexicon's `maxGraphemes` constraint on
 *   strings containing emoji / surrogate pairs / combining marks; see
 *   `lib/graphemes.ts`).
 */
export async function postReviewAction(
  db: Db,
  session: OAuthSession,
  input: PostReviewInput,
): Promise<PostReviewResult> {
  const target = await requirePerfumeInCache(db, input.perfumeUri);
  const rating = requireIntInRange(input.rating, "rating", 1, 10);
  const sillage = requireIntInRange(input.sillage, "sillage", 1, 5);
  const longevity = requireIntInRange(input.longevity, "longevity", 1, 5);
  const rawBody = requireString(input.body, "body");
  if (rawBody.trim().length === 0) bad("body must not be empty");
  // Issue #129/#130: sanitize at the write edge so no renderer has to
  // be trusted. Reject after sanitization so a script-only body is a
  // 400 rather than a silently-empty record.
  const body = sanitizeFreeText(rawBody, "body");
  if (countGraphemes(body) > 15000) bad("body too long (max 15000 graphemes)");

  const createdAt = nowDatetime();
  const lexClient = new Client(session);
  const res = await lexClient.create(app.smellgate.review.main, {
    perfume: target,
    rating,
    sillage,
    longevity,
    body,
    createdAt,
  });
  return {
    uri: res.uri,
    record: {
      perfumeUri: input.perfumeUri,
      rating,
      sillage,
      longevity,
      body,
      createdAt: createdAt as unknown as string,
    },
  };
}

/**
 * Write a `app.smellgate.description` record to the user's PDS.
 *
 * Validation: `perfumeUri` must resolve, body non-empty, ≤ 5000
 * graphemes (counted with `Intl.Segmenter`; see `lib/graphemes.ts`).
 */
export async function postDescriptionAction(
  db: Db,
  session: OAuthSession,
  input: PostDescriptionInput,
): Promise<PostDescriptionResult> {
  const target = await requirePerfumeInCache(db, input.perfumeUri);
  const rawBody = requireString(input.body, "body");
  if (rawBody.trim().length === 0) bad("body must not be empty");
  // Issue #130: sanitize at the write edge. Community descriptions
  // are shown on the public perfume detail page, so this is the
  // highest-risk surface for the "render trusts the cache" foot-gun.
  const body = sanitizeFreeText(rawBody, "body");
  if (countGraphemes(body) > 5000) bad("body too long (max 5000 graphemes)");

  const createdAt = nowDatetime();
  const lexClient = new Client(session);
  const res = await lexClient.create(app.smellgate.description.main, {
    perfume: target,
    body,
    createdAt,
  });
  return {
    uri: res.uri,
    record: {
      perfumeUri: input.perfumeUri,
      body,
      createdAt: createdAt as unknown as string,
    },
  };
}

/**
 * Write a `app.smellgate.vote` record to the user's PDS.
 *
 * Validation: `descriptionUri` must resolve in the cache; `direction`
 * must be exactly `"up"` or `"down"`. The write is still add-only at
 * the ATProto level — each vote becomes a new record — but before
 * creating we attempt to delete any prior vote records from the same
 * author pointing at the same subject (issue #135 part 2, the
 * duplicate-vote guard). See the inline comment on the cleanup block
 * for why we read-then-delete rather than use strict uniqueness.
 */
export async function voteOnDescriptionAction(
  db: Db,
  session: OAuthSession,
  input: VoteOnDescriptionInput,
): Promise<VoteOnDescriptionResult> {
  const subjectUri = input.descriptionUri;
  if (!isNonEmptyString(subjectUri, 8192)) bad("descriptionUri is required");
  if (input.direction !== "up" && input.direction !== "down") {
    bad('direction must be "up" or "down"');
  }
  const cid = await getDescriptionCid(db, subjectUri);
  if (!cid) notFound(`unknown description: ${subjectUri}`);

  // Issue #135: self-vote guard. The description URI's authority IS
  // the author DID — that's how ATProto at-uris work ("at://<did>/..."),
  // so we can derive the author without another DB round-trip.
  let authorDid: string;
  try {
    authorDid = new AtUri(subjectUri).hostname;
  } catch {
    bad(`invalid descriptionUri: ${subjectUri}`);
  }
  if (authorDid === session.did) {
    bad("cannot vote on your own description");
  }

  const lexClient = new Client(session);

  // Issue #135 part 2: duplicate-vote guard at write time. The
  // read-layer dedupe in `loadVoteTallies` keeps display sane but
  // does not stop users from piling up vote records in their repo —
  // which is both wasteful and a latent data-integrity smell if we
  // ever ship a non-deduping renderer.
  //
  // Strategy: before creating a new vote, ask the user's PDS for
  // their existing votes in the vote collection, find any that point
  // at `subjectUri`, and delete them. Then write the new vote. This
  // is a best-effort "replace the prior vote" rather than a hard 409
  // — flipping a vote up→down is a normal user action and should
  // succeed, just without accumulating records.
  //
  // We use the session's authenticated fetchHandler directly rather
  // than the lexicon client because we just need the raw listRecords
  // + deleteRecord endpoints. The 100-record threshold is a ceiling
  // on the user's *total* votes we scan per call, not a per-subject
  // limit: a user would have to cast hundreds of votes total before
  // an older stray vote on this same subject fell off the first
  // page. Even in that degraded case we still succeed in cleaning
  // the most recent duplicate and fall back to the read-layer
  // dedupe for anything missed.
  try {
    const listUrl =
      `/xrpc/com.atproto.repo.listRecords` +
      `?repo=${encodeURIComponent(session.did)}` +
      `&collection=app.smellgate.vote` +
      `&limit=100`;
    const listRes = await session.fetchHandler(listUrl, { method: "GET" });
    if (listRes.ok) {
      const body = (await listRes.json()) as {
        records: {
          uri: string;
          value: { subject?: { uri?: string } };
        }[];
      };
      for (const rec of body.records) {
        if (rec.value?.subject?.uri === subjectUri) {
          const { rkey } = new AtUri(rec.uri);
          const delBody = {
            repo: session.did,
            collection: "app.smellgate.vote",
            rkey,
          };
          await session.fetchHandler(`/xrpc/com.atproto.repo.deleteRecord`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(delBody),
          });
        }
      }
    }
    // If listRecords fails we proceed anyway — the create call is
    // still the authoritative write and the read-time dedupe keeps
    // display correct. Logging rather than throwing is the right
    // default: a transient PDS hiccup shouldn't block the vote itself.
  } catch (err) {
    console.warn(
      `voteOnDescriptionAction: failed to clean up prior votes on ${subjectUri}:`,
      err,
    );
  }

  const createdAt = nowDatetime();
  const res = await lexClient.create(app.smellgate.vote.main, {
    subject: strongRef(subjectUri, cid),
    direction: input.direction,
    createdAt,
  });
  return {
    uri: res.uri,
    record: {
      descriptionUri: subjectUri,
      direction: input.direction,
      createdAt: createdAt as unknown as string,
    },
  };
}

/**
 * Write a `app.smellgate.comment` record to the user's PDS.
 *
 * Validation: `reviewUri` must resolve in the cache; body non-empty,
 * ≤ 5000 graphemes (counted with `Intl.Segmenter`; see
 * `lib/graphemes.ts`).
 */
export async function commentOnReviewAction(
  db: Db,
  session: OAuthSession,
  input: CommentOnReviewInput,
): Promise<CommentOnReviewResult> {
  const subjectUri = input.reviewUri;
  if (!isNonEmptyString(subjectUri, 8192)) bad("reviewUri is required");
  const rawBody = requireString(input.body, "body");
  if (rawBody.trim().length === 0) bad("body must not be empty");
  // Issue #129/#130: sanitize at the write edge for comments too.
  const body = sanitizeFreeText(rawBody, "body");
  if (countGraphemes(body) > 5000) bad("body too long (max 5000 graphemes)");
  const cid = await getReviewCid(db, subjectUri);
  if (!cid) notFound(`unknown review: ${subjectUri}`);

  const createdAt = nowDatetime();
  const lexClient = new Client(session);
  const res = await lexClient.create(app.smellgate.comment.main, {
    subject: strongRef(subjectUri, cid),
    body,
    createdAt,
  });
  return {
    uri: res.uri,
    record: {
      reviewUri: subjectUri,
      body,
      createdAt: createdAt as unknown as string,
    },
  };
}

/**
 * Write a `app.smellgate.perfumeSubmission` record to the user's PDS.
 *
 * Any authenticated user may submit — there is NO curator gate here.
 * The submission lives in the user's own repo and is resolved later by
 * a curator-authored `perfumeSubmissionResolution`.
 *
 * Validation:
 * - `name`, `house` non-empty strings, ≤ 200 graphemes each (issue
 *   #134). Trimmed on the way in.
 * - `notes` non-empty array; each entry lowercased + trimmed and
 *   non-empty after trim. Per docs/lexicons.md: "Normalized lowercase."
 *   Duplicates are de-duplicated in order.
 * - `creator` (when present) non-empty, ≤ 200 graphemes (issue #134).
 * - `description`, `rationale` (when present) non-empty after HTML
 *   sanitization; body-length is already capped at the lexicon's
 *   `maxGraphemes` elsewhere.
 * - `releaseYear` (when present) an integer in
 *   `[1700, currentUtcYear + 1]` (issue #133). See
 *   `write-guards.ts#requireReleaseYear` for the range justification.
 *
 * We intentionally do not touch the cache here. Unlike the
 * Phase 3.B actions we have no strongRef to validate against —
 * a submission is a leaf record.
 */
export async function submitPerfumeAction(
  db: Db,
  session: OAuthSession,
  input: SubmitPerfumeInput,
): Promise<SubmitPerfumeResult> {
  // Issue #134: bound short-identifier fields at 200 graphemes each.
  // Same ceiling for name / house / creator — they share a failure mode
  // (user pastes a wall of text into what should be a short label).
  const name = requireBoundedIdentifier(input.name, "name");
  const house = requireBoundedIdentifier(input.house, "house");

  // Canonical note normalization — NFC, trim, collapse whitespace,
  // lowercase, strip edge emoji, dedupe. Throws 400 on whitespace-only
  // entries. See lib/server/write-guards.ts (issue #128).
  const notes = normalizeNotes(input.notes);

  let creator: string | undefined;
  if (input.creator !== undefined) {
    creator = requireBoundedIdentifier(input.creator, "creator");
  }

  // Issue #133: bound releaseYear to a plausible range. The lexicon
  // just says "integer" which accepts 2099 silently.
  let releaseYear: number | undefined;
  if (input.releaseYear !== undefined) {
    releaseYear = requireReleaseYear(input.releaseYear);
  }

  // Issue #129: sanitize the submission description at the write edge.
  // No downstream renderer is trusted; we store plaintext.
  let description: string | undefined;
  if (input.description !== undefined) {
    if (typeof input.description !== "string") {
      bad("description must be a string when provided");
    }
    if (input.description.trim().length === 0) {
      bad("description must be a non-empty string when provided");
    }
    description = sanitizeFreeText(input.description, "description");
  }

  let rationale: string | undefined;
  if (input.rationale !== undefined) {
    if (typeof input.rationale !== "string") {
      bad("rationale must be a string when provided");
    }
    if (input.rationale.trim().length === 0) {
      bad("rationale must be a non-empty string when provided");
    }
    rationale = sanitizeFreeText(input.rationale, "rationale");
  }

  const lexClient = new Client(session);

  // Issue #126: idempotent duplicate-submission guard. Before creating
  // a new submission, scan the user's own PDS for prior
  // `app.smellgate.perfumeSubmission` records that case-fold to the
  // same (name, house). If we find one, return it and mark the response
  // `idempotent: true` rather than writing a second pending record.
  //
  // Why scan the PDS and not the local Tap cache: the cache lags the
  // firehose, and the worst cache-miss case is exactly the one this
  // guard is trying to close (double-submit within the firehose delay).
  // A single `listRecords` page against the submitter's own repo is
  // authoritative and fast.
  //
  // The cap on scanned records is the default listRecords page
  // (100). A submitter with >100 prior submissions who also manages to
  // double-submit an old one would fall through to a new record — we
  // accept that edge case rather than paginate. The curator flow
  // already tolerates duplicates via `markDuplicate`.
  try {
    const listUrl =
      `/xrpc/com.atproto.repo.listRecords` +
      `?repo=${encodeURIComponent(session.did)}` +
      `&collection=app.smellgate.perfumeSubmission` +
      `&limit=100`;
    const listRes = await session.fetchHandler(listUrl, { method: "GET" });
    if (listRes.ok) {
      const body = (await listRes.json()) as {
        records?: {
          uri: string;
          value: {
            name?: unknown;
            house?: unknown;
            notes?: unknown;
            description?: unknown;
            rationale?: unknown;
            creator?: unknown;
            releaseYear?: unknown;
            createdAt?: unknown;
          };
        }[];
      };
      const nameKey = name.trim().toLowerCase();
      const houseKey = house.trim().toLowerCase();
      for (const rec of body.records ?? []) {
        const v = rec.value ?? {};
        const n = typeof v.name === "string" ? v.name.trim().toLowerCase() : "";
        const h =
          typeof v.house === "string" ? v.house.trim().toLowerCase() : "";
        if (n !== nameKey || h !== houseKey) continue;

        // Only short-circuit when the prior submission is still
        // genuinely pending. If a curator already resolved it —
        // approved, rejected, or marked duplicate — the new attempt
        // is a fresh proposal (e.g. "try again with more notes after
        // a rejection") and lying that it's "queued for curator
        // review" would actively mislead the user. Fall through to
        // the normal write path in that case.
        const resolution = await getResolutionForSubmission(db, rec.uri);
        if (resolution) continue;

        // Found a prior PENDING submission for the same
        // (name, house). Echo it back idempotently. The submitter can
        // see the status on /profile/me/submissions (#131).
        return {
          uri: rec.uri,
          status: "pending_review",
          message:
            "You already have a submission for this perfume queued for curator review.",
          idempotent: true,
          record: {
            name: typeof v.name === "string" ? v.name : name,
            house: typeof v.house === "string" ? v.house : house,
            ...(typeof v.creator === "string" ? { creator: v.creator } : {}),
            ...(typeof v.releaseYear === "number"
              ? { releaseYear: v.releaseYear }
              : {}),
            notes: Array.isArray(v.notes)
              ? (v.notes as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : notes,
            ...(typeof v.description === "string"
              ? { description: v.description }
              : {}),
            ...(typeof v.rationale === "string"
              ? { rationale: v.rationale }
              : {}),
            createdAt:
              typeof v.createdAt === "string"
                ? v.createdAt
                : new Date().toISOString(),
          },
          normalized: {
            notes: Array.isArray(v.notes)
              ? (v.notes as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : notes,
            ...(typeof v.description === "string"
              ? { description: v.description }
              : {}),
            ...(typeof v.rationale === "string"
              ? { rationale: v.rationale }
              : {}),
          },
        };
      }
    }
    // On non-200 we proceed to write a fresh record. A transient PDS
    // read error should not block a submission that is itself a write
    // — failing-open matches the voteOnDescription precedent.
  } catch (err) {
    console.warn(
      `submitPerfumeAction: duplicate-check list failed for did=${session.did}:`,
      err,
    );
  }

  const createdAt = nowDatetime();
  const res = await lexClient.create(app.smellgate.perfumeSubmission.main, {
    name,
    house,
    creator,
    releaseYear,
    notes,
    description,
    rationale,
    createdAt,
  });
  return {
    uri: res.uri,
    status: "pending_review",
    message: "Your submission is queued for curator review.",
    record: {
      name,
      house,
      ...(creator !== undefined ? { creator } : {}),
      ...(releaseYear !== undefined ? { releaseYear } : {}),
      notes,
      ...(description !== undefined ? { description } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
      createdAt: createdAt as unknown as string,
    },
    normalized: {
      notes,
      description,
      rationale,
    },
  };
}

// ---------------------------------------------------------------------------
// My submissions listing (issue #131)
// ---------------------------------------------------------------------------

/**
 * Resolution state of a single submission from the submitter's
 * perspective. `pending` means no resolution exists yet. The three
 * resolution-kind strings mirror the lexicon enum.
 */
export type SubmissionState = "pending" | "approved" | "rejected" | "duplicate";

export interface MySubmissionItem {
  uri: string;
  state: SubmissionState;
  name: string;
  house: string;
  creator?: string;
  releaseYear?: number;
  notes: string[];
  description?: string;
  rationale?: string;
  createdAt: string;
  /** Canonical perfume AT-URI from the resolution (approved / duplicate only). */
  resolvedPerfumeUri?: string;
  /** Curator's note on rejection, if provided. */
  resolutionNote?: string;
  /** Resolution record's own AT-URI, useful for audit links. */
  resolutionUri?: string;
}

/**
 * Group a flat list of submissions by resolution state. Pure function
 * so it can be unit-tested without touching the PDS. Ordering within
 * each bucket follows input order (which in turn is PDS list order —
 * newest first, the ATProto default).
 *
 * Exported for unit tests AND for consumers that want to pre-sort the
 * `/profile/me/submissions` page.
 */
export function groupSubmissionsByState(
  items: MySubmissionItem[],
): Record<SubmissionState, MySubmissionItem[]> {
  const out: Record<SubmissionState, MySubmissionItem[]> = {
    pending: [],
    approved: [],
    rejected: [],
    duplicate: [],
  };
  for (const item of items) {
    out[item.state].push(item);
  }
  return out;
}

/**
 * List the authenticated user's own `app.smellgate.perfumeSubmission`
 * records (from their PDS), cross-referenced against the cached
 * resolution table to determine state. Issue #131.
 *
 * Why cache for resolutions: resolutions are curator-authored and
 * live in the curator's repo, not the submitter's. The submitter's
 * PDS can't show them directly. The local Tap cache is the cheap,
 * app-local way to join those two sides without federating
 * per-request. Cache lag means a very freshly resolved submission
 * will show as `pending` until the firehose catches up — acceptable
 * because the alternative is "follow every curator DID around and
 * query their repo", which isn't feasible at request time.
 *
 * A single page (100) of the user's submissions is the maximum this
 * returns today. Most submitters will stay well under. If we ever
 * see a prolific submitter we'll paginate.
 */
export async function listMySubmissionsAction(
  db: Db,
  session: OAuthSession,
): Promise<MySubmissionItem[]> {
  const lexClient = new Client(session);
  const res = await lexClient.list(app.smellgate.perfumeSubmission.main, {
    limit: 100,
  });

  const items: MySubmissionItem[] = [];
  for (const rec of res.records) {
    const value = rec.value as {
      name?: string;
      house?: string;
      creator?: string;
      releaseYear?: number;
      notes?: string[];
      description?: string;
      rationale?: string;
      createdAt?: string;
    };
    const resolution = await getResolutionForSubmission(db, rec.uri);

    let state: SubmissionState;
    let resolvedPerfumeUri: string | undefined;
    let resolutionNote: string | undefined;
    let resolutionUri: string | undefined;
    if (!resolution) {
      state = "pending";
    } else {
      resolutionUri = resolution.uri;
      resolvedPerfumeUri = resolution.perfume_uri ?? undefined;
      resolutionNote = resolution.note ?? undefined;
      if (
        resolution.decision === "approved" ||
        resolution.decision === "rejected" ||
        resolution.decision === "duplicate"
      ) {
        state = resolution.decision;
      } else {
        // Defensive: any unknown decision value (should be impossible
        // given the lexicon enum, but cache rows are just strings)
        // falls back to `pending` rather than throwing.
        state = "pending";
      }
    }

    items.push({
      uri: rec.uri,
      state,
      name: value.name ?? "",
      house: value.house ?? "",
      ...(typeof value.creator === "string" ? { creator: value.creator } : {}),
      ...(typeof value.releaseYear === "number"
        ? { releaseYear: value.releaseYear }
        : {}),
      notes: Array.isArray(value.notes)
        ? value.notes.filter((n): n is string => typeof n === "string")
        : [],
      ...(typeof value.description === "string"
        ? { description: value.description }
        : {}),
      ...(typeof value.rationale === "string"
        ? { rationale: value.rationale }
        : {}),
      createdAt:
        typeof value.createdAt === "string"
          ? value.createdAt
          : new Date(0).toISOString(),
      ...(resolvedPerfumeUri ? { resolvedPerfumeUri } : {}),
      ...(resolutionNote ? { resolutionNote } : {}),
      ...(resolutionUri ? { resolutionUri } : {}),
    });
  }

  // Sort newest-first by `createdAt`. PDS list order is implementation-
  // defined and recovery-order after firehose re-index can shuffle
  // records; sorting explicitly keeps the page stable.
  // Lexicographic string compare on ISO-8601 is equivalent to numeric
  // compare by epoch, so `localeCompare` is sufficient.
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}
