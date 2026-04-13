/**
 * OAuth-gated server-action implementations for `com.smellgate.*` writes
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
import type { Kysely } from "kysely";
import * as com from "../lexicons/com";
import { getPerfumeByUri } from "../db/smellgate-queries";
import type { DatabaseSchema } from "../db";

type Db = Kysely<DatabaseSchema>;

/**
 * The lexicons in `lib/lexicons/com/smellgate/*.defs.ts` use branded
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

async function requirePerfumeInCache(
  db: Db,
  uri: string,
): Promise<{ uri: l.AtUriString; cid: l.CidString }> {
  if (!isNonEmptyString(uri, 8192)) bad("perfumeUri is required");
  const row = await getPerfumeByUri(db, uri);
  if (!row) notFound(`unknown perfume: ${uri}`);
  return strongRef(row.uri, row.cid);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Write a `com.smellgate.shelfItem` record to the user's PDS.
 *
 * Validation:
 * - `perfumeUri` must resolve to a known perfume in the cache.
 * - `acquiredAt`, when present, must parse as a date.
 * - `bottleSizeMl`, when present, must be a positive integer.
 * - `isDecant`, when present, must be a boolean.
 */
export async function addToShelfAction(
  db: Db,
  session: OAuthSession,
  input: AddToShelfInput,
): Promise<ActionResult> {
  const target = await requirePerfumeInCache(db, input.perfumeUri);

  const acquiredAt = requireDatetime(input.acquiredAt, "acquiredAt");
  let bottleSizeMl: number | undefined;
  if (input.bottleSizeMl !== undefined) {
    if (!isFiniteInt(input.bottleSizeMl) || input.bottleSizeMl <= 0) {
      bad("bottleSizeMl must be a positive integer");
    }
    bottleSizeMl = input.bottleSizeMl;
  }
  let isDecant: boolean | undefined;
  if (input.isDecant !== undefined) {
    if (typeof input.isDecant !== "boolean") bad("isDecant must be a boolean");
    isDecant = input.isDecant;
  }

  const lexClient = new Client(session);
  const res = await lexClient.create(com.smellgate.shelfItem.main, {
    perfume: target,
    acquiredAt,
    bottleSizeMl,
    isDecant,
    createdAt: nowDatetime(),
  });
  return { uri: res.uri };
}

/**
 * Write a `com.smellgate.review` record to the user's PDS.
 *
 * Validation:
 * - `perfumeUri` must resolve in the cache.
 * - `rating` integer in [1, 10].
 * - `sillage` integer in [1, 5].
 * - `longevity` integer in [1, 5].
 * - `body` non-empty, ≤ 15000 graphemes (we approximate with character
 *   length — the lexicon does the strict grapheme count on parse).
 */
export async function postReviewAction(
  db: Db,
  session: OAuthSession,
  input: PostReviewInput,
): Promise<ActionResult> {
  const target = await requirePerfumeInCache(db, input.perfumeUri);
  const rating = requireIntInRange(input.rating, "rating", 1, 10);
  const sillage = requireIntInRange(input.sillage, "sillage", 1, 5);
  const longevity = requireIntInRange(input.longevity, "longevity", 1, 5);
  const body = requireString(input.body, "body");
  if (body.trim().length === 0) bad("body must not be empty");
  if (body.length > 15000) bad("body must be ≤ 15000 characters");

  const lexClient = new Client(session);
  const res = await lexClient.create(com.smellgate.review.main, {
    perfume: target,
    rating,
    sillage,
    longevity,
    body,
    createdAt: nowDatetime(),
  });
  return { uri: res.uri };
}

/**
 * Write a `com.smellgate.description` record to the user's PDS.
 *
 * Validation: `perfumeUri` must resolve, body non-empty, ≤ 5000 chars.
 */
export async function postDescriptionAction(
  db: Db,
  session: OAuthSession,
  input: PostDescriptionInput,
): Promise<ActionResult> {
  const target = await requirePerfumeInCache(db, input.perfumeUri);
  const body = requireString(input.body, "body");
  if (body.trim().length === 0) bad("body must not be empty");
  if (body.length > 5000) bad("body must be ≤ 5000 characters");

  const lexClient = new Client(session);
  const res = await lexClient.create(com.smellgate.description.main, {
    perfume: target,
    body,
    createdAt: nowDatetime(),
  });
  return { uri: res.uri };
}

/**
 * Write a `com.smellgate.vote` record to the user's PDS.
 *
 * Validation: `descriptionUri` must resolve in the cache; `direction`
 * must be exactly `"up"` or `"down"`. We do NOT delete or mutate any
 * prior vote record from the same user — Phase 2.B's read-time dedupe
 * keeps only the latest vote per (author, subject) and that's the
 * agreed model. Add-only writes.
 */
export async function voteOnDescriptionAction(
  db: Db,
  session: OAuthSession,
  input: VoteOnDescriptionInput,
): Promise<ActionResult> {
  const subjectUri = input.descriptionUri;
  if (!isNonEmptyString(subjectUri, 8192)) bad("descriptionUri is required");
  if (input.direction !== "up" && input.direction !== "down") {
    bad('direction must be "up" or "down"');
  }
  const cid = await getDescriptionCid(db, subjectUri);
  if (!cid) notFound(`unknown description: ${subjectUri}`);

  const lexClient = new Client(session);
  const res = await lexClient.create(com.smellgate.vote.main, {
    subject: strongRef(subjectUri, cid),
    direction: input.direction,
    createdAt: nowDatetime(),
  });
  return { uri: res.uri };
}

/**
 * Write a `com.smellgate.comment` record to the user's PDS.
 *
 * Validation: `reviewUri` must resolve in the cache; body non-empty,
 * ≤ 5000 chars.
 */
export async function commentOnReviewAction(
  db: Db,
  session: OAuthSession,
  input: CommentOnReviewInput,
): Promise<ActionResult> {
  const subjectUri = input.reviewUri;
  if (!isNonEmptyString(subjectUri, 8192)) bad("reviewUri is required");
  const body = requireString(input.body, "body");
  if (body.trim().length === 0) bad("body must not be empty");
  if (body.length > 5000) bad("body must be ≤ 5000 characters");
  const cid = await getReviewCid(db, subjectUri);
  if (!cid) notFound(`unknown review: ${subjectUri}`);

  const lexClient = new Client(session);
  const res = await lexClient.create(com.smellgate.comment.main, {
    subject: strongRef(subjectUri, cid),
    body,
    createdAt: nowDatetime(),
  });
  return { uri: res.uri };
}

/**
 * Write a `com.smellgate.perfumeSubmission` record to the user's PDS.
 *
 * Any authenticated user may submit — there is NO curator gate here.
 * The submission lives in the user's own repo and is resolved later by
 * a curator-authored `perfumeSubmissionResolution`.
 *
 * Validation:
 * - `name`, `house` non-empty strings.
 * - `notes` non-empty array; each entry lowercased + trimmed and
 *   non-empty after trim. Per docs/lexicons.md: "Normalized lowercase."
 *   Duplicates are de-duplicated in order.
 * - `creator`, `description`, `rationale` (when present) non-empty.
 * - `releaseYear` (when present) a finite integer.
 *
 * We intentionally do not touch the cache here. Unlike the
 * Phase 3.B actions we have no strongRef to validate against —
 * a submission is a leaf record.
 */
export async function submitPerfumeAction(
  _db: Db,
  session: OAuthSession,
  input: SubmitPerfumeInput,
): Promise<ActionResult> {
  const name = requireString(input.name, "name");
  if (name.trim().length === 0) bad("name must not be empty");
  const house = requireString(input.house, "house");
  if (house.trim().length === 0) bad("house must not be empty");

  if (!Array.isArray(input.notes) || input.notes.length === 0) {
    bad("notes must be a non-empty array");
  }
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const raw of input.notes) {
    if (typeof raw !== "string") bad("notes must be an array of strings");
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) bad("notes must not contain empty strings");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    notes.push(normalized);
  }

  let creator: string | undefined;
  if (input.creator !== undefined) {
    if (typeof input.creator !== "string" || input.creator.trim().length === 0) {
      bad("creator must be a non-empty string when provided");
    }
    creator = input.creator;
  }

  let releaseYear: number | undefined;
  if (input.releaseYear !== undefined) {
    if (!isFiniteInt(input.releaseYear)) {
      bad("releaseYear must be an integer when provided");
    }
    releaseYear = input.releaseYear;
  }

  let description: string | undefined;
  if (input.description !== undefined) {
    if (
      typeof input.description !== "string" ||
      input.description.trim().length === 0
    ) {
      bad("description must be a non-empty string when provided");
    }
    description = input.description;
  }

  let rationale: string | undefined;
  if (input.rationale !== undefined) {
    if (
      typeof input.rationale !== "string" ||
      input.rationale.trim().length === 0
    ) {
      bad("rationale must be a non-empty string when provided");
    }
    rationale = input.rationale;
  }

  const lexClient = new Client(session);
  const res = await lexClient.create(com.smellgate.perfumeSubmission.main, {
    name,
    house,
    creator,
    releaseYear,
    notes,
    description,
    rationale,
    createdAt: nowDatetime(),
  });
  return { uri: res.uri };
}
