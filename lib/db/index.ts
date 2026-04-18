import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

const DATABASE_PATH = process.env.DATABASE_PATH || "app.db";

let _db: Kysely<DatabaseSchema> | null = null;

export const getDb = (): Kysely<DatabaseSchema> => {
  if (!_db) {
    const sqlite = new Database(DATABASE_PATH);
    sqlite.pragma("journal_mode = WAL");

    _db = new Kysely<DatabaseSchema>({
      dialect: new SqliteDialect({ database: sqlite }),
    });
  }
  return _db;
};

export interface DatabaseSchema {
  auth_state: AuthStateTable;
  auth_session: AuthSessionTable;
  account: AccountTable;
  status: StatusTable;
  // Phase 2 read cache for app.smellgate.* records
  smellgate_perfume: SmellgatePerfumeTable;
  smellgate_perfume_note: SmellgatePerfumeNoteTable;
  smellgate_perfume_submission: SmellgatePerfumeSubmissionTable;
  smellgate_perfume_submission_note: SmellgatePerfumeSubmissionNoteTable;
  smellgate_perfume_submission_resolution: SmellgatePerfumeSubmissionResolutionTable;
  smellgate_shelf_item: SmellgateShelfItemTable;
  smellgate_review: SmellgateReviewTable;
  smellgate_description: SmellgateDescriptionTable;
  smellgate_vote: SmellgateVoteTable;
  smellgate_comment: SmellgateCommentTable;
}

interface AuthStateTable {
  key: string;
  value: string;
}

interface AuthSessionTable {
  key: string;
  value: string;
}

export interface AccountTable {
  did: string;
  handle: string;
  active: 0 | 1;
}

export interface StatusTable {
  uri: string;
  authorDid: string;
  status: string;
  createdAt: string;
  indexedAt: string;
  current: 0 | 1;
}

// ---------------------------------------------------------------------------
// app.smellgate.* read-cache tables (Phase 2).
//
// Conventions:
// - `uri` is the AT-URI of the record and the primary key.
// - `cid` is the record content CID, stored so the UI can pin and show
//   "this review was written against version X" per docs/lexicons.md.
// - `author_did` is the repo the record was authored in (the firehose
//   event's `did`), which is the right answer for "whose record is this".
// - `indexed_at` is the unix millisecond timestamp at which the Tap
//   dispatcher first wrote the row. Distinct from the in-record
//   `created_at` (which is author-controlled and not trustworthy for
//   ordering).
// - Body fields that the read layer needs to filter on (house, creator,
//   direction, decision, perfume strongRef) are denormalized into their
//   own columns. Repeated fields (notes) live in companion join tables
//   so tag lookups are plain index scans. Arrays that aren't used for
//   filtering (externalRefs) round-trip through a JSON TEXT column.
// - No foreign keys between tables: firehose order is not dependency
//   order, so a vote can legitimately arrive before its description.
//   Refs are plain AT-URI strings.
// ---------------------------------------------------------------------------

export interface SmellgatePerfumeTable {
  uri: string;
  cid: string;
  author_did: string;
  indexed_at: number;
  name: string;
  house: string;
  creator: string | null;
  release_year: number | null;
  description: string | null;
  external_refs_json: string | null;
  created_at: string;
}

export interface SmellgatePerfumeNoteTable {
  perfume_uri: string;
  note: string;
}

export interface SmellgatePerfumeSubmissionTable {
  uri: string;
  cid: string;
  author_did: string;
  indexed_at: number;
  name: string;
  house: string;
  creator: string | null;
  release_year: number | null;
  description: string | null;
  rationale: string | null;
  created_at: string;
}

export interface SmellgatePerfumeSubmissionNoteTable {
  submission_uri: string;
  note: string;
}

export interface SmellgatePerfumeSubmissionResolutionTable {
  uri: string;
  cid: string;
  author_did: string;
  indexed_at: number;
  submission_uri: string;
  submission_cid: string;
  decision: "approved" | "rejected" | "duplicate";
  perfume_uri: string | null;
  perfume_cid: string | null;
  note: string | null;
  created_at: string;
}

export interface SmellgateShelfItemTable {
  uri: string;
  cid: string;
  author_did: string;
  indexed_at: number;
  perfume_uri: string;
  perfume_cid: string;
  acquired_at: string | null;
  bottle_size_ml: number | null;
  is_decant: 0 | 1 | null;
  created_at: string;
}

export interface SmellgateReviewTable {
  uri: string;
  cid: string;
  author_did: string;
  indexed_at: number;
  perfume_uri: string;
  perfume_cid: string;
  rating: number;
  sillage: number;
  longevity: number;
  body: string;
  created_at: string;
}

export interface SmellgateDescriptionTable {
  uri: string;
  cid: string;
  author_did: string;
  indexed_at: number;
  perfume_uri: string;
  perfume_cid: string;
  body: string;
  created_at: string;
}

export interface SmellgateVoteTable {
  uri: string;
  cid: string;
  author_did: string;
  indexed_at: number;
  subject_uri: string;
  subject_cid: string;
  direction: "up" | "down";
  created_at: string;
}

export interface SmellgateCommentTable {
  uri: string;
  cid: string;
  author_did: string;
  indexed_at: number;
  subject_uri: string;
  subject_cid: string;
  body: string;
  created_at: string;
}
