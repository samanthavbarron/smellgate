/**
 * Unit tests for `lib/db/smellgate-queries.ts`.
 *
 * These are unit tests in the sense that they don't require a PDS or
 * the Tap webhook — only SQLite + the query module. They use the
 * real migration runner and the real Kysely instance against a
 * per-test tmpdir SQLite file, mirroring the setup in
 * `tests/integration/tap-smellgate-cache.test.ts`. Test data is
 * inserted directly into the cache tables (which is how Phase 2.A's
 * dispatcher ends up writing them), so the tests are exercising the
 * query code against a schema and dataset a curator / user would
 * produce in production.
 *
 * No mocks. Real better-sqlite3, real Kysely, real migrations.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueriesModule = typeof import("../../../lib/db/smellgate-queries");
type DbIndexModule = typeof import("../../../lib/db");
type MigrationsModule = typeof import("../../../lib/db/migrations");

const USER_A = "did:plc:usera0000000";
const USER_B = "did:plc:userb0000000";
const USER_C = "did:plc:userc0000000";
const CURATOR = "did:plc:curator00000";

async function freshEnv(): Promise<{
  q: QueriesModule;
  db: DbIndexModule;
  dispose: () => void;
}> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-queries-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  vi.resetModules();

  const migrations: MigrationsModule = await import(
    "../../../lib/db/migrations"
  );
  const { error } = await migrations.getMigrator().migrateToLatest();
  if (error) throw error;

  const db: DbIndexModule = await import("../../../lib/db");
  const q: QueriesModule = await import("../../../lib/db/smellgate-queries");

  return {
    q,
    db,
    dispose: () => {
      try {
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

// Sequence counter so every row we insert has a distinct indexed_at
// and URI, regardless of which test inserts it. Tests don't share
// the DB (each test gets a fresh tmpdir), but a shared counter makes
// it impossible to accidentally write two rows with the same
// indexed_at and then flake on ordering.
let seq = 0;
function nextIndexedAt(): number {
  seq += 1;
  return 1_700_000_000_000 + seq;
}
function atUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`;
}

// -------------------------------------------------------------------------
// Insert helpers — write directly into the cache tables. Mirrors what
// the dispatcher would do, minus the lexicon validation/gates.
// -------------------------------------------------------------------------

interface PerfumeSeed {
  uri?: string;
  name: string;
  house: string;
  creator?: string | null;
  notes?: string[];
  releaseYear?: number;
}
async function seedPerfume(
  db: DbIndexModule,
  seed: PerfumeSeed,
): Promise<string> {
  const k = seed.uri ?? atUri(CURATOR, "com.smellgate.perfume", `p${seq + 1}`);
  const indexedAt = nextIndexedAt();
  await db
    .getDb()
    .insertInto("smellgate_perfume")
    .values({
      uri: k,
      cid: `bafkreic${(indexedAt % 1000).toString().padStart(3, "0")}fake`,
      author_did: CURATOR,
      indexed_at: indexedAt,
      name: seed.name,
      house: seed.house,
      creator: seed.creator ?? null,
      release_year: seed.releaseYear ?? null,
      description: null,
      external_refs_json: null,
      created_at: new Date(indexedAt).toISOString(),
    })
    .execute();
  if (seed.notes && seed.notes.length > 0) {
    await db
      .getDb()
      .insertInto("smellgate_perfume_note")
      .values(seed.notes.map((note) => ({ perfume_uri: k, note })))
      .execute();
  }
  return k;
}

async function seedShelfItem(
  db: DbIndexModule,
  author: string,
  perfumeUri: string,
): Promise<string> {
  const uri = atUri(author, "com.smellgate.shelfItem", `s${seq + 1}`);
  const indexedAt = nextIndexedAt();
  await db
    .getDb()
    .insertInto("smellgate_shelf_item")
    .values({
      uri,
      cid: "bafkreicshelf0000fake",
      author_did: author,
      indexed_at: indexedAt,
      perfume_uri: perfumeUri,
      perfume_cid: "bafkreicperfume00fake",
      acquired_at: null,
      bottle_size_ml: null,
      is_decant: null,
      created_at: new Date(indexedAt).toISOString(),
    })
    .execute();
  return uri;
}

async function seedReview(
  db: DbIndexModule,
  author: string,
  perfumeUri: string,
  body = "nice",
): Promise<string> {
  const uri = atUri(author, "com.smellgate.review", `r${seq + 1}`);
  const indexedAt = nextIndexedAt();
  await db
    .getDb()
    .insertInto("smellgate_review")
    .values({
      uri,
      cid: "bafkreicreview000fake",
      author_did: author,
      indexed_at: indexedAt,
      perfume_uri: perfumeUri,
      perfume_cid: "bafkreicperfume00fake",
      rating: 7,
      sillage: 5,
      longevity: 6,
      body,
      created_at: new Date(indexedAt).toISOString(),
    })
    .execute();
  return uri;
}

async function seedDescription(
  db: DbIndexModule,
  author: string,
  perfumeUri: string,
  body = "smells like",
): Promise<string> {
  const uri = atUri(author, "com.smellgate.description", `d${seq + 1}`);
  const indexedAt = nextIndexedAt();
  await db
    .getDb()
    .insertInto("smellgate_description")
    .values({
      uri,
      cid: "bafkreicdesc0000fake",
      author_did: author,
      indexed_at: indexedAt,
      perfume_uri: perfumeUri,
      perfume_cid: "bafkreicperfume00fake",
      body,
      created_at: new Date(indexedAt).toISOString(),
    })
    .execute();
  return uri;
}

async function seedVote(
  db: DbIndexModule,
  author: string,
  subjectUri: string,
  direction: "up" | "down",
): Promise<string> {
  const uri = atUri(author, "com.smellgate.vote", `v${seq + 1}`);
  const indexedAt = nextIndexedAt();
  await db
    .getDb()
    .insertInto("smellgate_vote")
    .values({
      uri,
      cid: "bafkreicvote0000fake",
      author_did: author,
      indexed_at: indexedAt,
      subject_uri: subjectUri,
      subject_cid: "bafkreicdesc0000fake",
      direction,
      created_at: new Date(indexedAt).toISOString(),
    })
    .execute();
  return uri;
}

async function seedComment(
  db: DbIndexModule,
  author: string,
  reviewUri: string,
  body: string,
): Promise<string> {
  const uri = atUri(author, "com.smellgate.comment", `c${seq + 1}`);
  const indexedAt = nextIndexedAt();
  await db
    .getDb()
    .insertInto("smellgate_comment")
    .values({
      uri,
      cid: "bafkreiccomment0fake",
      author_did: author,
      indexed_at: indexedAt,
      subject_uri: reviewUri,
      subject_cid: "bafkreicreview000fake",
      body,
      created_at: new Date(indexedAt).toISOString(),
    })
    .execute();
  return uri;
}

async function seedSubmission(
  db: DbIndexModule,
  author: string,
  name: string,
): Promise<string> {
  const uri = atUri(author, "com.smellgate.perfumeSubmission", `sb${seq + 1}`);
  const indexedAt = nextIndexedAt();
  await db
    .getDb()
    .insertInto("smellgate_perfume_submission")
    .values({
      uri,
      cid: "bafkreicsub00000fake",
      author_did: author,
      indexed_at: indexedAt,
      name,
      house: "Some House",
      creator: null,
      release_year: null,
      description: null,
      rationale: null,
      created_at: new Date(indexedAt).toISOString(),
    })
    .execute();
  return uri;
}

async function seedResolution(
  db: DbIndexModule,
  submissionUri: string,
  decision: "approved" | "rejected" | "duplicate",
): Promise<string> {
  const uri = atUri(
    CURATOR,
    "com.smellgate.perfumeSubmissionResolution",
    `rs${seq + 1}`,
  );
  const indexedAt = nextIndexedAt();
  await db
    .getDb()
    .insertInto("smellgate_perfume_submission_resolution")
    .values({
      uri,
      cid: "bafkreicresn0000fake",
      author_did: CURATOR,
      indexed_at: indexedAt,
      submission_uri: submissionUri,
      submission_cid: "bafkreicsub00000fake",
      decision,
      perfume_uri: null,
      perfume_cid: null,
      note: null,
      created_at: new Date(indexedAt).toISOString(),
    })
    .execute();
  return uri;
}

// -------------------------------------------------------------------------

describe("smellgate-queries", () => {
  let env: Awaited<ReturnType<typeof freshEnv>>;

  beforeEach(async () => {
    seq = 0;
    env = await freshEnv();
  });

  afterEach(() => {
    env.dispose();
    vi.unstubAllEnvs();
  });

  describe("getPerfumeByUri", () => {
    it("returns the row with its notes", async () => {
      const uri = await seedPerfume(env.db, {
        name: "No. 5",
        house: "Chanel",
        notes: ["aldehyde", "rose", "jasmine"],
      });
      const got = await env.q.getPerfumeByUri(env.db.getDb(), uri);
      expect(got).not.toBeNull();
      expect(got!.name).toBe("No. 5");
      expect(got!.house).toBe("Chanel");
      expect(got!.notes.sort()).toEqual(["aldehyde", "jasmine", "rose"]);
    });

    it("returns null for an unknown URI", async () => {
      const got = await env.q.getPerfumeByUri(
        env.db.getDb(),
        "at://did:plc:nobody/com.smellgate.perfume/ghost",
      );
      expect(got).toBeNull();
    });

    it("returns an empty notes array when a perfume has no notes", async () => {
      const uri = await seedPerfume(env.db, { name: "Bare", house: "X" });
      const got = await env.q.getPerfumeByUri(env.db.getDb(), uri);
      expect(got).not.toBeNull();
      expect(got!.notes).toEqual([]);
    });
  });

  describe("getPerfumesByNote", () => {
    it("returns only perfumes carrying the note, each with full notes", async () => {
      const a = await seedPerfume(env.db, {
        name: "A",
        house: "H",
        notes: ["rose", "oud"],
      });
      const b = await seedPerfume(env.db, {
        name: "B",
        house: "H",
        notes: ["oud", "amber"],
      });
      await seedPerfume(env.db, { name: "C", house: "H", notes: ["lemon"] });

      const got = await env.q.getPerfumesByNote(env.db.getDb(), "oud");
      const uris = got.map((p) => p.uri).sort();
      expect(uris).toEqual([a, b].sort());
      const rose = got.find((p) => p.uri === a)!;
      expect(rose.notes.sort()).toEqual(["oud", "rose"]);
    });

    it("honors limit and offset", async () => {
      for (let i = 0; i < 5; i += 1) {
        await seedPerfume(env.db, {
          name: `P${i}`,
          house: "H",
          notes: ["common"],
        });
      }
      const page1 = await env.q.getPerfumesByNote(env.db.getDb(), "common", {
        limit: 2,
        offset: 0,
      });
      const page2 = await env.q.getPerfumesByNote(env.db.getDb(), "common", {
        limit: 2,
        offset: 2,
      });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      const overlap = page1
        .map((p) => p.uri)
        .filter((u) => page2.some((p2) => p2.uri === u));
      expect(overlap).toEqual([]);
    });
  });

  describe("getPerfumesByHouse", () => {
    it("returns only perfumes for the given house", async () => {
      const ch = await seedPerfume(env.db, {
        name: "X",
        house: "Chanel",
        notes: ["rose"],
      });
      await seedPerfume(env.db, { name: "Y", house: "Dior", notes: ["iris"] });
      const got = await env.q.getPerfumesByHouse(env.db.getDb(), "Chanel");
      expect(got.map((p) => p.uri)).toEqual([ch]);
      expect(got[0].notes).toEqual(["rose"]);
    });

    it("returns [] when no perfume matches", async () => {
      await seedPerfume(env.db, { name: "Y", house: "Dior" });
      const got = await env.q.getPerfumesByHouse(env.db.getDb(), "MissingCo");
      expect(got).toEqual([]);
    });
  });

  describe("getPerfumesByCreator", () => {
    it("filters on creator and returns notes", async () => {
      const ed = await seedPerfume(env.db, {
        name: "Z",
        house: "H",
        creator: "Ernest Beaux",
        notes: ["musk"],
      });
      await seedPerfume(env.db, { name: "Q", house: "H", creator: "Someone" });
      const got = await env.q.getPerfumesByCreator(
        env.db.getDb(),
        "Ernest Beaux",
      );
      expect(got.map((p) => p.uri)).toEqual([ed]);
      expect(got[0].notes).toEqual(["musk"]);
    });

    it("ignores NULL creator rows", async () => {
      await seedPerfume(env.db, { name: "Anon", house: "H", creator: null });
      const got = await env.q.getPerfumesByCreator(env.db.getDb(), "Someone");
      expect(got).toEqual([]);
    });
  });

  describe("getUserShelf", () => {
    it("returns shelf items for a user joined with perfume data", async () => {
      const p1 = await seedPerfume(env.db, {
        name: "One",
        house: "H",
        notes: ["rose"],
      });
      const p2 = await seedPerfume(env.db, {
        name: "Two",
        house: "H",
        notes: ["oud"],
      });
      await seedShelfItem(env.db, USER_A, p1);
      await seedShelfItem(env.db, USER_A, p2);
      await seedShelfItem(env.db, USER_B, p1);

      const got = await env.q.getUserShelf(env.db.getDb(), USER_A);
      expect(got).toHaveLength(2);
      for (const item of got) {
        expect(item.author_did).toBe(USER_A);
        expect(item.perfume).not.toBeNull();
      }
      const names = got.map((i) => i.perfume!.name).sort();
      expect(names).toEqual(["One", "Two"]);
    });

    it("returns [] for a user with no shelf", async () => {
      const got = await env.q.getUserShelf(env.db.getDb(), USER_A);
      expect(got).toEqual([]);
    });

    it("returns the shelf item with perfume: null if the perfume row is missing", async () => {
      // This can happen: firehose order is not dependency order, and
      // a shelf item can arrive before its referenced perfume.
      const missingPerfume = atUri(
        CURATOR,
        "com.smellgate.perfume",
        "ghost",
      );
      await seedShelfItem(env.db, USER_A, missingPerfume);
      const got = await env.q.getUserShelf(env.db.getDb(), USER_A);
      expect(got).toHaveLength(1);
      expect(got[0].perfume).toBeNull();
    });
  });

  describe("getUserReviews", () => {
    it("returns reviews authored by the user, newest first", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const r1 = await seedReview(env.db, USER_A, p, "first");
      const r2 = await seedReview(env.db, USER_A, p, "second");
      const r3 = await seedReview(env.db, USER_A, p, "third");
      await seedReview(env.db, USER_B, p, "other");

      const got = await env.q.getUserReviews(env.db.getDb(), USER_A);
      expect(got.map((r) => r.uri)).toEqual([r3, r2, r1]);
    });

    it("returns [] when the user has no reviews", async () => {
      const got = await env.q.getUserReviews(env.db.getDb(), USER_A);
      expect(got).toEqual([]);
    });
  });

  describe("getUserDescriptions", () => {
    it("returns descriptions authored by the user, newest first, with zero-vote tallies", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const d1 = await seedDescription(env.db, USER_A, p, "one");
      const d2 = await seedDescription(env.db, USER_A, p, "two");
      await seedDescription(env.db, USER_B, p, "other");

      const got = await env.q.getUserDescriptions(env.db.getDb(), USER_A);
      expect(got.map((d) => d.uri)).toEqual([d2, d1]);
      // With no votes cast, every row should still carry a tally shape.
      expect(got[0].up_count).toBe(0);
      expect(got[0].down_count).toBe(0);
      expect(got[0].score).toBe(0);
    });

    it("returns [] when the user has no descriptions", async () => {
      const got = await env.q.getUserDescriptions(env.db.getDb(), USER_A);
      expect(got).toEqual([]);
    });

    it("pagination limit works", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      for (let i = 0; i < 3; i += 1) {
        await seedDescription(env.db, USER_A, p, `d${i}`);
      }
      const got = await env.q.getUserDescriptions(env.db.getDb(), USER_A, {
        limit: 2,
      });
      expect(got).toHaveLength(2);
    });

    it("attaches up/down/score from votes on the user's descriptions", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const d1 = await seedDescription(env.db, USER_A, p, "one");
      const d2 = await seedDescription(env.db, USER_A, p, "two");
      // d1: +2 / -0
      await seedVote(env.db, USER_B, d1, "up");
      await seedVote(env.db, USER_C, d1, "up");
      // d2: +1 / -1
      await seedVote(env.db, USER_B, d2, "up");
      await seedVote(env.db, USER_C, d2, "down");

      const got = await env.q.getUserDescriptions(env.db.getDb(), USER_A);
      // Ordering is by indexed_at DESC, so d2 is first.
      const byUri = new Map(got.map((d) => [d.uri, d]));
      expect(byUri.get(d1)).toMatchObject({
        up_count: 2,
        down_count: 0,
        score: 2,
      });
      expect(byUri.get(d2)).toMatchObject({
        up_count: 1,
        down_count: 1,
        score: 0,
      });
    });

    it("dedupes votes: only each author's most recent vote counts", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const d = await seedDescription(env.db, USER_A, p);
      // USER_B votes up, then later votes down. Only the down should count.
      await seedVote(env.db, USER_B, d, "up");
      await seedVote(env.db, USER_B, d, "down");
      // USER_C only votes up.
      await seedVote(env.db, USER_C, d, "up");

      const got = await env.q.getUserDescriptions(env.db.getDb(), USER_A);
      expect(got).toHaveLength(1);
      expect(got[0].up_count).toBe(1);
      expect(got[0].down_count).toBe(1);
      expect(got[0].score).toBe(0);
    });
  });

  describe("getReviewsForPerfume", () => {
    it("returns reviews for the perfume, newest first", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const r1 = await seedReview(env.db, USER_A, p, "a");
      const r2 = await seedReview(env.db, USER_B, p, "b");
      const got = await env.q.getReviewsForPerfume(env.db.getDb(), p);
      expect(got.map((r) => r.uri)).toEqual([r2, r1]);
    });

    it("ignores reviews on other perfumes", async () => {
      const p1 = await seedPerfume(env.db, { name: "1", house: "H" });
      const p2 = await seedPerfume(env.db, { name: "2", house: "H" });
      await seedReview(env.db, USER_A, p2);
      const got = await env.q.getReviewsForPerfume(env.db.getDb(), p1);
      expect(got).toEqual([]);
    });
  });

  describe("getDescriptionsForPerfume", () => {
    it("returns descriptions sorted by score desc, with up/down/score", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const d1 = await seedDescription(env.db, USER_A, p, "one");
      const d2 = await seedDescription(env.db, USER_B, p, "two");
      const d3 = await seedDescription(env.db, USER_C, p, "three");

      // d1: +2 / -0 = 2
      await seedVote(env.db, USER_B, d1, "up");
      await seedVote(env.db, USER_C, d1, "up");
      // d2: +1 / -1 = 0
      await seedVote(env.db, USER_A, d2, "up");
      await seedVote(env.db, USER_C, d2, "down");
      // d3: +0 / -1 = -1
      await seedVote(env.db, USER_A, d3, "down");

      const got = await env.q.getDescriptionsForPerfume(env.db.getDb(), p);
      expect(got.map((d) => d.uri)).toEqual([d1, d2, d3]);
      expect(got[0].score).toBe(2);
      expect(got[0].up_count).toBe(2);
      expect(got[0].down_count).toBe(0);
      expect(got[1].score).toBe(0);
      expect(got[1].up_count).toBe(1);
      expect(got[1].down_count).toBe(1);
      expect(got[2].score).toBe(-1);
    });

    it("dedupes multiple votes from the same author, keeping the most recent", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const d = await seedDescription(env.db, USER_A, p);
      // User B votes up, then later votes down. Only the down should count.
      await seedVote(env.db, USER_B, d, "up");
      await seedVote(env.db, USER_B, d, "down");
      // User C only votes up.
      await seedVote(env.db, USER_C, d, "up");

      const got = await env.q.getDescriptionsForPerfume(env.db.getDb(), p);
      expect(got).toHaveLength(1);
      expect(got[0].up_count).toBe(1);
      expect(got[0].down_count).toBe(1);
      expect(got[0].score).toBe(0);
    });

    it("returns [] for a perfume with no descriptions", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const got = await env.q.getDescriptionsForPerfume(env.db.getDb(), p);
      expect(got).toEqual([]);
    });
  });

  describe("getVoteTally", () => {
    it("counts up and down", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const d = await seedDescription(env.db, USER_A, p);
      await seedVote(env.db, USER_B, d, "up");
      await seedVote(env.db, USER_C, d, "down");
      const tally = await env.q.getVoteTally(env.db.getDb(), d);
      expect(tally).toEqual({ up: 1, down: 1 });
    });

    it("dedupes: only the most recent vote from each author counts", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const d = await seedDescription(env.db, USER_A, p);
      await seedVote(env.db, USER_B, d, "up");
      await seedVote(env.db, USER_B, d, "down");
      await seedVote(env.db, USER_B, d, "up");
      const tally = await env.q.getVoteTally(env.db.getDb(), d);
      expect(tally).toEqual({ up: 1, down: 0 });
    });

    it("returns zeros when no votes exist", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const d = await seedDescription(env.db, USER_A, p);
      const tally = await env.q.getVoteTally(env.db.getDb(), d);
      expect(tally).toEqual({ up: 0, down: 0 });
    });
  });

  describe("getCommentsForReview", () => {
    it("returns comments for the review, oldest first", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const r = await seedReview(env.db, USER_A, p);
      const c1 = await seedComment(env.db, USER_B, r, "first!");
      const c2 = await seedComment(env.db, USER_C, r, "agreed");
      const c3 = await seedComment(env.db, USER_A, r, "thanks");
      const got = await env.q.getCommentsForReview(env.db.getDb(), r);
      expect(got.map((c) => c.uri)).toEqual([c1, c2, c3]);
    });

    it("ignores comments on other reviews", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const r1 = await seedReview(env.db, USER_A, p);
      const r2 = await seedReview(env.db, USER_A, p);
      await seedComment(env.db, USER_B, r2, "other");
      const got = await env.q.getCommentsForReview(env.db.getDb(), r1);
      expect(got).toEqual([]);
    });
  });

  describe("getPendingSubmissions", () => {
    it("returns submissions with no resolution, oldest first", async () => {
      const s1 = await seedSubmission(env.db, USER_A, "alpha");
      const s2 = await seedSubmission(env.db, USER_B, "beta");
      const s3 = await seedSubmission(env.db, USER_C, "gamma");
      // Resolve s2.
      await seedResolution(env.db, s2, "approved");

      const got = await env.q.getPendingSubmissions(env.db.getDb());
      expect(got.map((s) => s.uri)).toEqual([s1, s3]);
      expect(got[0].name).toBe("alpha");
    });

    it("returns [] when all submissions are resolved", async () => {
      const s = await seedSubmission(env.db, USER_A, "only");
      await seedResolution(env.db, s, "rejected");
      const got = await env.q.getPendingSubmissions(env.db.getDb());
      expect(got).toEqual([]);
    });
  });

  describe("getResolutionForSubmission", () => {
    it("returns the resolution row", async () => {
      const s = await seedSubmission(env.db, USER_A, "alpha");
      const r = await seedResolution(env.db, s, "duplicate");
      const got = await env.q.getResolutionForSubmission(env.db.getDb(), s);
      expect(got).not.toBeNull();
      expect(got!.uri).toBe(r);
      expect(got!.decision).toBe("duplicate");
    });

    it("returns null when there is no resolution", async () => {
      const s = await seedSubmission(env.db, USER_A, "alpha");
      const got = await env.q.getResolutionForSubmission(env.db.getDb(), s);
      expect(got).toBeNull();
    });
  });
});
