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
  const k = seed.uri ?? atUri(CURATOR, "app.smellgate.perfume", `p${seq + 1}`);
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
  const uri = atUri(author, "app.smellgate.shelfItem", `s${seq + 1}`);
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
  rating = 7,
): Promise<string> {
  const uri = atUri(author, "app.smellgate.review", `r${seq + 1}`);
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
      rating,
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
  const uri = atUri(author, "app.smellgate.description", `d${seq + 1}`);
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
  const uri = atUri(author, "app.smellgate.vote", `v${seq + 1}`);
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
  const uri = atUri(author, "app.smellgate.comment", `c${seq + 1}`);
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
  const uri = atUri(author, "app.smellgate.perfumeSubmission", `sb${seq + 1}`);
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
    "app.smellgate.perfumeSubmissionResolution",
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
        "at://did:plc:nobody/app.smellgate.perfume/ghost",
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
        "app.smellgate.perfume",
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

  describe("searchPerfumes", () => {
    it("returns an empty array for an empty or whitespace query (does not match everything)", async () => {
      await seedPerfume(env.db, { name: "Vespertine", house: "Oriza" });
      await seedPerfume(env.db, { name: "Matin", house: "Chanel" });
      expect(await env.q.searchPerfumes(env.db.getDb(), "")).toEqual([]);
      expect(await env.q.searchPerfumes(env.db.getDb(), "   ")).toEqual([]);
    });

    it("substring-matches the perfume name case-insensitively", async () => {
      await seedPerfume(env.db, { name: "Vespertine", house: "Oriza" });
      await seedPerfume(env.db, { name: "Matin Calme", house: "Chanel" });
      const got = await env.q.searchPerfumes(env.db.getDb(), "VESP");
      expect(got.map((p) => p.name)).toEqual(["Vespertine"]);
    });

    it("substring-matches the house case-insensitively", async () => {
      await seedPerfume(env.db, { name: "Alpha", house: "Guerlain" });
      await seedPerfume(env.db, { name: "Bravo", house: "Oriza L. Legrand" });
      const got = await env.q.searchPerfumes(env.db.getDb(), "oriza");
      expect(got.map((p) => p.name)).toEqual(["Bravo"]);
    });

    it("matches on name OR house in a single query", async () => {
      await seedPerfume(env.db, { name: "Ambre Solaire", house: "Chanel" });
      await seedPerfume(env.db, { name: "Fig Leaf", house: "Ambre House" });
      await seedPerfume(env.db, { name: "Unrelated", house: "Other" });
      const got = await env.q.searchPerfumes(env.db.getDb(), "ambre");
      // name ASC => "Ambre Solaire" before "Fig Leaf"
      expect(got.map((p) => p.name)).toEqual(["Ambre Solaire", "Fig Leaf"]);
    });

    it("treats % and _ in the query as literal characters, not wildcards", async () => {
      await seedPerfume(env.db, { name: "50% Off", house: "A" });
      await seedPerfume(env.db, { name: "50 percent", house: "B" });
      await seedPerfume(env.db, { name: "snake_case", house: "C" });
      await seedPerfume(env.db, { name: "snakeXcase", house: "D" });

      const pct = await env.q.searchPerfumes(env.db.getDb(), "50%");
      expect(pct.map((p) => p.name)).toEqual(["50% Off"]);

      const underscore = await env.q.searchPerfumes(env.db.getDb(), "snake_");
      expect(underscore.map((p) => p.name)).toEqual(["snake_case"]);
    });

    it("respects limit and offset and orders by name ASC", async () => {
      await seedPerfume(env.db, { name: "Rose Delta", house: "X" });
      await seedPerfume(env.db, { name: "Rose Alpha", house: "X" });
      await seedPerfume(env.db, { name: "Rose Charlie", house: "X" });
      await seedPerfume(env.db, { name: "Rose Bravo", house: "X" });

      const page1 = await env.q.searchPerfumes(env.db.getDb(), "rose", {
        limit: 2,
        offset: 0,
      });
      expect(page1.map((p) => p.name)).toEqual(["Rose Alpha", "Rose Bravo"]);

      const page2 = await env.q.searchPerfumes(env.db.getDb(), "rose", {
        limit: 2,
        offset: 2,
      });
      expect(page2.map((p) => p.name)).toEqual(["Rose Charlie", "Rose Delta"]);
    });

    it("returns notes as a string array on each result", async () => {
      await seedPerfume(env.db, {
        name: "Vespertine",
        house: "Oriza",
        notes: ["iris", "ambergris", "vetiver"],
      });
      const got = await env.q.searchPerfumes(env.db.getDb(), "vespertine");
      expect(got).toHaveLength(1);
      expect(Array.isArray(got[0].notes)).toBe(true);
      expect(got[0].notes.sort()).toEqual(["ambergris", "iris", "vetiver"]);
    });

    // #121: extend search to also match creator and notes.
    it("substring-matches the creator case-insensitively", async () => {
      await seedPerfume(env.db, {
        name: "Terre d'Hermès",
        house: "Hermès",
        creator: "Jean-Claude Ellena",
      });
      await seedPerfume(env.db, {
        name: "Chanel No. 5",
        house: "Chanel",
        creator: "Ernest Beaux",
      });
      const got = await env.q.searchPerfumes(env.db.getDb(), "ellena");
      expect(got.map((p) => p.name)).toEqual(["Terre d'Hermès"]);
    });

    it("does not match on a NULL creator", async () => {
      // Guard against a naive `LIKE` on NULL accidentally returning
      // every row; LOWER(NULL) LIKE … is NULL (falsy) but worth
      // pinning down.
      await seedPerfume(env.db, {
        name: "Anonymous",
        house: "H",
        creator: null,
      });
      const got = await env.q.searchPerfumes(env.db.getDb(), "ellena");
      expect(got).toEqual([]);
    });

    it("substring-matches a note value case-insensitively", async () => {
      await seedPerfume(env.db, {
        name: "Vetiver Fatal",
        house: "Atelier Cologne",
        notes: ["vetiver", "grapefruit"],
      });
      await seedPerfume(env.db, {
        name: "Sycomore",
        house: "Chanel",
        notes: ["VETIVER", "cypress"],
      });
      await seedPerfume(env.db, {
        name: "Unrelated",
        house: "H",
        notes: ["rose"],
      });
      const got = await env.q.searchPerfumes(env.db.getDb(), "VETIVER");
      // Both perfumes match via their note; Vetiver Fatal also matches
      // on name, but should still appear exactly once.
      expect(got.map((p) => p.name)).toEqual(["Sycomore", "Vetiver Fatal"]);
    });

    it("deduplicates: a perfume matching via name and via a note appears once", async () => {
      await seedPerfume(env.db, {
        name: "Rose Absolue",
        house: "H",
        notes: ["rose", "rosewood"],
      });
      const got = await env.q.searchPerfumes(env.db.getDb(), "rose");
      expect(got).toHaveLength(1);
      expect(got[0].name).toBe("Rose Absolue");
      // Notes come back fully attached (not truncated to the match).
      expect(got[0].notes.sort()).toEqual(["rose", "rosewood"]);
    });

    it("preserves LIKE-escape safety across the new fields too", async () => {
      // A `%` or `_` in the user query must not wildcard — including
      // when the potential match is on creator or notes.
      await seedPerfume(env.db, {
        name: "Baseline",
        house: "H",
        creator: "100%_Artisan",
        notes: ["100%_note"],
      });
      await seedPerfume(env.db, {
        name: "Decoy",
        house: "H",
        creator: "100XArtisan",
        notes: ["100Xnote"],
      });

      const pct = await env.q.searchPerfumes(env.db.getDb(), "100%");
      expect(pct.map((p) => p.name)).toEqual(["Baseline"]);

      const underscore = await env.q.searchPerfumes(env.db.getDb(), "%_");
      expect(underscore.map((p) => p.name)).toEqual(["Baseline"]);
    });
  });

  // #127: surface catalog-level dup candidates at submit time. The
  // query is name + house both, case-insensitive equality (not LIKE).
  describe("findCanonicalByNameHouse", () => {
    it("returns an exact case-insensitive match on name + house", async () => {
      const pUri = await seedPerfume(env.db, {
        name: "Vespertine",
        house: "Maison Vésper",
        creator: "Jeanne Castel",
        releaseYear: 1927,
      });
      const got = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "VESPERTINE",
        "maison vésper",
      );
      expect(got.map((p) => p.uri)).toEqual([pUri]);
      expect(got[0].name).toBe("Vespertine");
      expect(got[0].house).toBe("Maison Vésper");
    });

    it("returns [] when house matches but name does not", async () => {
      await seedPerfume(env.db, {
        name: "Vespertine",
        house: "Maison Vésper",
      });
      const got = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "Matinale",
        "Maison Vésper",
      );
      expect(got).toEqual([]);
    });

    it("returns [] when name matches but house does not", async () => {
      await seedPerfume(env.db, {
        name: "Vespertine",
        house: "Maison Vésper",
      });
      const got = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "Vespertine",
        "Different House",
      );
      expect(got).toEqual([]);
    });

    it("returns [] on empty or whitespace-only name/house", async () => {
      await seedPerfume(env.db, { name: "X", house: "Y" });
      expect(
        await env.q.findCanonicalByNameHouse(env.db.getDb(), "", "Y"),
      ).toEqual([]);
      expect(
        await env.q.findCanonicalByNameHouse(env.db.getDb(), "   ", "Y"),
      ).toEqual([]);
      expect(
        await env.q.findCanonicalByNameHouse(env.db.getDb(), "X", "  "),
      ).toEqual([]);
    });

    it("trims both sides before comparing", async () => {
      const pUri = await seedPerfume(env.db, {
        name: "Vespertine",
        house: "Maison Vésper",
      });
      const got = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "  Vespertine ",
        "\tMaison Vésper  ",
      );
      expect(got.map((p) => p.uri)).toEqual([pUri]);
    });

    // The Tap dispatcher writes canonical records' `name` / `house`
    // as-authored (no trim), so a curator PDS entry with trailing
    // whitespace would otherwise miss a legitimate trimmed submission
    // input. SQL-side `trim(col)` closes that gap.
    it("trims the stored column too, not just the input", async () => {
      const pUri = await seedPerfume(env.db, {
        name: "Vespertine ",
        house: " Maison Vésper",
      });
      const got = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "Vespertine",
        "Maison Vésper",
      );
      expect(got.map((p) => p.uri)).toEqual([pUri]);
    });

    it("does not LIKE-wildcard: a literal % in the query matches only a stored %", async () => {
      // Substring attempts must fail. "Vespertine EDP" is NOT the same
      // catalog entry as "Vespertine" — the match is exact equality.
      await seedPerfume(env.db, { name: "Vespertine EDP", house: "Maison" });
      const got = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "Vespertine",
        "Maison",
      );
      expect(got).toEqual([]);

      // And conversely, a query with a literal % should not wildcard
      // across the stored name — it only matches a stored value that
      // literally contains the same sequence.
      await seedPerfume(env.db, { name: "50% Off", house: "HouseA" });
      const pctOk = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "50% Off",
        "HouseA",
      );
      expect(pctOk.map((p) => p.name)).toEqual(["50% Off"]);
      // A percent-only query should not match "50% Off".
      const pctNope = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "%",
        "HouseA",
      );
      expect(pctNope).toEqual([]);
    });

    it("caps the result set at the supplied limit (default 3)", async () => {
      // Seed 4 canonical perfumes with the same (name, house). Rare
      // in practice (would require curator approval of four variants)
      // but the cap is part of the contract — verify it trims.
      for (let i = 0; i < 4; i++) {
        await seedPerfume(env.db, {
          name: "Same Name",
          house: "Same House",
          creator: `Creator ${i}`,
        });
      }
      const gotDefault = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "Same Name",
        "Same House",
      );
      expect(gotDefault).toHaveLength(3);

      const gotOne = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "Same Name",
        "Same House",
        1,
      );
      expect(gotOne).toHaveLength(1);
    });

    it("orders by indexed_at DESC with uri DESC as a total-order tiebreaker", async () => {
      // Insert three rows with controlled indexed_at. seedPerfume uses
      // a strictly increasing counter — so insertion order IS newest-
      // last. Newest-first means the last-inserted row comes first.
      const older = await seedPerfume(env.db, {
        uri: "at://did:plc:c/app.smellgate.perfume/aaa",
        name: "Tiebreak",
        house: "Tiebreak House",
      });
      const middle = await seedPerfume(env.db, {
        uri: "at://did:plc:c/app.smellgate.perfume/bbb",
        name: "Tiebreak",
        house: "Tiebreak House",
      });
      const newer = await seedPerfume(env.db, {
        uri: "at://did:plc:c/app.smellgate.perfume/ccc",
        name: "Tiebreak",
        house: "Tiebreak House",
      });

      const got = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "Tiebreak",
        "Tiebreak House",
      );
      expect(got.map((p) => p.uri)).toEqual([newer, middle, older]);
    });

    it("attaches notes on the returned rows", async () => {
      await seedPerfume(env.db, {
        name: "Vespertine",
        house: "Maison Vésper",
        notes: ["iris", "ambergris"],
      });
      const got = await env.q.findCanonicalByNameHouse(
        env.db.getDb(),
        "Vespertine",
        "Maison Vésper",
      );
      expect(got).toHaveLength(1);
      expect(got[0].notes.sort()).toEqual(["ambergris", "iris"]);
    });
  });

  describe("getReviewByUri", () => {
    it("returns the review row when it exists", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const r = await seedReview(env.db, USER_A, p, "body");
      const got = await env.q.getReviewByUri(env.db.getDb(), r);
      expect(got).not.toBeNull();
      expect(got!.uri).toBe(r);
      expect(got!.author_did).toBe(USER_A);
      expect(got!.perfume_uri).toBe(p);
      expect(got!.body).toBe("body");
    });

    it("returns null when the review does not exist", async () => {
      const got = await env.q.getReviewByUri(
        env.db.getDb(),
        "at://did:plc:nobody/app.smellgate.review/ghost",
      );
      expect(got).toBeNull();
    });
  });

  describe("getRecentPerfumes", () => {
    it("returns [] when the cache is empty", async () => {
      const got = await env.q.getRecentPerfumes(env.db.getDb());
      expect(got).toEqual([]);
    });

    it("orders by indexed_at DESC, with notes attached", async () => {
      const p1 = await seedPerfume(env.db, {
        name: "First",
        house: "H",
        notes: ["rose"],
      });
      const p2 = await seedPerfume(env.db, {
        name: "Second",
        house: "H",
        notes: ["oud"],
      });
      const p3 = await seedPerfume(env.db, {
        name: "Third",
        house: "H",
      });
      const got = await env.q.getRecentPerfumes(env.db.getDb());
      expect(got.map((p) => p.uri)).toEqual([p3, p2, p1]);
      const byUri = new Map(got.map((p) => [p.uri, p]));
      expect(byUri.get(p1)!.notes).toEqual(["rose"]);
      expect(byUri.get(p2)!.notes).toEqual(["oud"]);
      expect(byUri.get(p3)!.notes).toEqual([]);
    });

    it("respects the limit option", async () => {
      for (let i = 0; i < 5; i += 1) {
        await seedPerfume(env.db, { name: `P${i}`, house: "H" });
      }
      const got = await env.q.getRecentPerfumes(env.db.getDb(), { limit: 2 });
      expect(got).toHaveLength(2);
    });
  });

  describe("getRecentReviews", () => {
    it("returns [] when the cache is empty", async () => {
      const got = await env.q.getRecentReviews(env.db.getDb());
      expect(got).toEqual([]);
    });

    it("orders by indexed_at DESC and joins the perfume slice", async () => {
      const p1 = await seedPerfume(env.db, { name: "Alpha", house: "Houze" });
      const p2 = await seedPerfume(env.db, { name: "Beta", house: "Other" });
      const r1 = await seedReview(env.db, USER_A, p1, "one");
      const r2 = await seedReview(env.db, USER_B, p2, "two");
      const r3 = await seedReview(env.db, USER_C, p1, "three");

      const got = await env.q.getRecentReviews(env.db.getDb());
      expect(got.map((r) => r.uri)).toEqual([r3, r2, r1]);
      const byUri = new Map(got.map((r) => [r.uri, r]));
      expect(byUri.get(r1)!.perfume).toEqual({
        uri: p1,
        name: "Alpha",
        house: "Houze",
      });
      expect(byUri.get(r2)!.perfume).toEqual({
        uri: p2,
        name: "Beta",
        house: "Other",
      });
    });

    it("returns perfume: null when the referenced perfume row is missing", async () => {
      const missing = atUri(CURATOR, "app.smellgate.perfume", "ghost");
      await seedReview(env.db, USER_A, missing, "orphan");
      const got = await env.q.getRecentReviews(env.db.getDb());
      expect(got).toHaveLength(1);
      expect(got[0].perfume).toBeNull();
    });

    it("respects the limit option", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      for (let i = 0; i < 5; i += 1) {
        await seedReview(env.db, USER_A, p, `body${i}`);
      }
      const got = await env.q.getRecentReviews(env.db.getDb(), { limit: 2 });
      expect(got).toHaveLength(2);
    });
  });

  describe("getCommentsForReviews", () => {
    it("returns an empty map for an empty input", async () => {
      const got = await env.q.getCommentsForReviews(env.db.getDb(), []);
      expect(got.size).toBe(0);
    });

    it("groups comments by review URI, oldest first per review, in one query", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const r1 = await seedReview(env.db, USER_A, p);
      const r2 = await seedReview(env.db, USER_B, p);
      const r3 = await seedReview(env.db, USER_C, p); // no comments
      const c1a = await seedComment(env.db, USER_B, r1, "first r1");
      const c1b = await seedComment(env.db, USER_C, r1, "second r1");
      const c2a = await seedComment(env.db, USER_A, r2, "first r2");

      const got = await env.q.getCommentsForReviews(env.db.getDb(), [
        r1,
        r2,
        r3,
      ]);
      expect(got.get(r1)!.map((c) => c.uri)).toEqual([c1a, c1b]);
      expect(got.get(r2)!.map((c) => c.uri)).toEqual([c2a]);
      expect(got.has(r3)).toBe(false);
    });

    it("ignores comments on reviews not in the input set", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      const r1 = await seedReview(env.db, USER_A, p);
      const r2 = await seedReview(env.db, USER_A, p);
      await seedComment(env.db, USER_B, r2, "on r2");

      const got = await env.q.getCommentsForReviews(env.db.getDb(), [r1]);
      expect(got.size).toBe(0);
    });
  });

  describe("getDescriptionsForPerfume — SQL pagination (#52)", () => {
    it("sorts by score DESC in SQL and applies limit/offset, preserving the author-dedupe rule", async () => {
      const p = await seedPerfume(env.db, { name: "P", house: "H" });
      // Seed 5 descriptions with varied scores.
      const d1 = await seedDescription(env.db, USER_A, p, "d1"); // score 3
      const d2 = await seedDescription(env.db, USER_B, p, "d2"); // score 1
      const d3 = await seedDescription(env.db, USER_C, p, "d3"); // score 0 (dedupe trap)
      const d4 = await seedDescription(env.db, USER_A, p, "d4"); // score 2
      const d5 = await seedDescription(env.db, USER_B, p, "d5"); // score -1

      // d1: +3 / -0 = 3
      await seedVote(env.db, USER_B, d1, "up");
      await seedVote(env.db, USER_C, d1, "up");
      await seedVote(env.db, USER_A, d1, "up");
      // d2: +1 / -0 = 1
      await seedVote(env.db, USER_A, d2, "up");
      // d3 — this is the dedupe trap. Without the NOT EXISTS filter,
      // these four rows would naively count as +3/-1 = 2 (tying d4),
      // bumping d3 into the top page even though USER_B's latest
      // vote is `down` and USER_C's latest vote is `down`:
      //   USER_B: up → down (latest: down)
      //   USER_C: up → down (latest: down)
      //   USER_A: (no vote)
      // Deduped: +0 / -2 = -2. Not +3 / -1 = 2.
      await seedVote(env.db, USER_B, d3, "up");
      await seedVote(env.db, USER_C, d3, "up");
      await seedVote(env.db, USER_B, d3, "down");
      await seedVote(env.db, USER_C, d3, "down");
      // d4: +2 / -0 = 2
      await seedVote(env.db, USER_B, d4, "up");
      await seedVote(env.db, USER_C, d4, "up");
      // d5: +0 / -1 = -1
      await seedVote(env.db, USER_A, d5, "down");

      const all = await env.q.getDescriptionsForPerfume(env.db.getDb(), p);
      // Expected order (score DESC, indexed_at DESC on ties):
      //   d1 (3), d4 (2), d2 (1), d5 (-1), d3 (-2)
      expect(all.map((d) => d.uri)).toEqual([d1, d4, d2, d5, d3]);
      expect(all.map((d) => d.score)).toEqual([3, 2, 1, -1, -2]);
      // d3 specifically should be LAST, not second — if the dedupe
      // had been dropped this test would fail because d3 would
      // naively score +3 / -1 = 2.
      const d3Row = all.find((d) => d.uri === d3)!;
      expect(d3Row.up_count).toBe(0);
      expect(d3Row.down_count).toBe(2);
      expect(d3Row.score).toBe(-2);

      // Pagination — limit 2, offset 0 returns the top 2.
      const page1 = await env.q.getDescriptionsForPerfume(env.db.getDb(), p, {
        limit: 2,
        offset: 0,
      });
      expect(page1.map((d) => d.uri)).toEqual([d1, d4]);

      // Pagination — limit 2, offset 2 returns the next slice.
      const page2 = await env.q.getDescriptionsForPerfume(env.db.getDb(), p, {
        limit: 2,
        offset: 2,
      });
      expect(page2.map((d) => d.uri)).toEqual([d2, d5]);

      // Pagination — limit 2, offset 4 returns the tail.
      const page3 = await env.q.getDescriptionsForPerfume(env.db.getDb(), p, {
        limit: 2,
        offset: 4,
      });
      expect(page3.map((d) => d.uri)).toEqual([d3]);
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

  describe("getSignatureNotesForUser (#217)", () => {
    it("returns empty for a user with no reviews or shelf items", async () => {
      const notes = await env.q.getSignatureNotesForUser(env.db.getDb(), USER_A);
      expect(notes).toEqual([]);
    });

    it("surfaces notes from high-rated reviews", async () => {
      const p1 = await seedPerfume(env.db, {
        name: "Rose One",
        house: "Y",
        notes: ["rose", "vetiver"],
      });
      const p2 = await seedPerfume(env.db, {
        name: "Rose Two",
        house: "Y",
        notes: ["rose", "oakmoss"],
      });
      await seedReview(env.db, USER_A, p1, "love", 10);
      await seedReview(env.db, USER_A, p2, "love", 10);
      const notes = await env.q.getSignatureNotesForUser(env.db.getDb(), USER_A);
      // Rose appears in both perfumes — it should rank highly for
      // USER_A. vetiver / oakmoss each appear once.
      expect(notes[0]).toBe("rose");
      expect(notes).toContain("vetiver");
      expect(notes).toContain("oakmoss");
    });

    it("weights shelf items (0.5 each) below high-rated reviews", async () => {
      const pShelf = await seedPerfume(env.db, {
        name: "Shelf One",
        house: "Z",
        notes: ["vanilla"],
      });
      const pReview = await seedPerfume(env.db, {
        name: "Review One",
        house: "Z",
        notes: ["galbanum"],
      });
      await seedShelfItem(env.db, USER_A, pShelf);
      await seedReview(env.db, USER_A, pReview, "great", 10);
      const notes = await env.q.getSignatureNotesForUser(env.db.getDb(), USER_A);
      // galbanum (1.0) ranks above vanilla (0.5) before baseline
      // adjustment — and both notes are catalog-unique so baseline
      // doesn't flip the order.
      expect(notes.indexOf("galbanum")).toBeLessThan(
        notes.indexOf("vanilla"),
      );
    });

    it("favors notes that are rare in the catalog (inverse-frequency)", async () => {
      // Seed a catalog where `rose` is in 5 perfumes and `galbanum`
      // is in 1 — both reviewed once by USER_A with the same rating.
      // `galbanum` should rank above `rose` despite equal user
      // weight, since it's more distinctive.
      for (let i = 0; i < 5; i += 1) {
        await seedPerfume(env.db, {
          name: `Rose ${i}`,
          house: "Y",
          notes: ["rose"],
        });
      }
      const userRose = await seedPerfume(env.db, {
        name: "User Rose",
        house: "Y",
        notes: ["rose"],
      });
      const userGalbanum = await seedPerfume(env.db, {
        name: "User Galbanum",
        house: "Y",
        notes: ["galbanum"],
      });
      await seedReview(env.db, USER_A, userRose, "ok", 10);
      await seedReview(env.db, USER_A, userGalbanum, "ok", 10);
      const notes = await env.q.getSignatureNotesForUser(env.db.getDb(), USER_A);
      expect(notes.indexOf("galbanum")).toBeLessThan(
        notes.indexOf("rose"),
      );
    });

    it("respects the limit parameter", async () => {
      const p = await seedPerfume(env.db, {
        name: "Many Notes",
        house: "Z",
        notes: Array.from({ length: 12 }, (_, i) => `note${i}`),
      });
      await seedReview(env.db, USER_A, p, "ok", 8);
      const notes = await env.q.getSignatureNotesForUser(
        env.db.getDb(),
        USER_A,
        5,
      );
      expect(notes.length).toBe(5);
    });
  });
});
