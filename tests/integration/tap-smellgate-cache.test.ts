/**
 * Integration tests for the Tap → read-cache dispatcher for
 * `app.smellgate.*` records.
 *
 * These tests exercise the real dispatch code in
 * `lib/tap/smellgate.ts` against a real SQLite database (migrated via
 * the real migration runner) using the real `$safeParse` validators
 * generated from the lexicons and the real `isCurator` helper loaded
 * from `lib/curators.ts`. Nothing is mocked.
 *
 * Why no in-process PDS here: the unit under test is the dispatch
 * function. It takes a Tap `RecordEvent`, validates the body, runs
 * gates, and writes SQLite. A PDS would only add the ceremony of
 * writing the same record into a real repo and pulling it back out —
 * which is exactly the shape of event these tests already construct
 * by hand. Per the issue: *"you can call the Tap consumer's
 * record-handling function directly with synthetic record events."*
 * The OAuth / PDS plumbing is already covered by
 * `oauth-pds.test.ts`; duplicating it here would slow the suite for
 * zero extra coverage of the dispatcher.
 *
 * Curator DIDs are configured by setting the
 * `SMELLGATE_CURATOR_DIDS` env var *before* dynamically importing
 * `lib/curators.ts` and `lib/tap/smellgate.ts`, because those modules
 * capture the curator list at module-load time. This mirrors the
 * pattern already used in `tests/unit/curators.test.ts`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordEvent } from "@atproto/tap";

// Fake but well-formed DIDs. The curators module just string-compares,
// so any `did:<method>:<id>` shape works.
const CURATOR_DID = "did:plc:alicecurator01";
const USER_DID = "did:plc:bobuser01";
// Separate author DID used for records the USER_DID votes / comments on
// so the dispatcher's self-vote guard (#191) doesn't fire against
// happy-path tests.
const OTHER_USER_DID = "did:plc:caroluser02";

const NSID = {
  perfume: "app.smellgate.perfume",
  perfumeSubmission: "app.smellgate.perfumeSubmission",
  perfumeSubmissionResolution: "app.smellgate.perfumeSubmissionResolution",
  shelfItem: "app.smellgate.shelfItem",
  review: "app.smellgate.review",
  description: "app.smellgate.description",
  vote: "app.smellgate.vote",
  comment: "app.smellgate.comment",
} as const;

// Real CIDs (sha256 raw) generated once from throwaway content. They
// need to be actual CIDs because the lexicon `cid` format check
// parses and round-trips the string; arbitrary base32 will fail. They
// are used here as opaque strings — the dispatcher never decodes them.
const FAKE_CID = "bafkreic34bborvtv2pquhi5vt3yjjuhzdhmlnqx263wmc3br2fu63evfiy";
const FAKE_CID2 = "bafkreicecy4kathmioy72xvtl7l2wjbfkdxe7zimlvf6tbqzsd6mofoeiy";

type TapModule = typeof import("../../lib/tap/smellgate");
type DbIndexModule = typeof import("../../lib/db");
type MigrationsModule = typeof import("../../lib/db/migrations");

// Each test gets its own SQLite file + its own module graph. Vitest's
// `vi.resetModules()` rewinds the ESM cache so the dynamic imports
// below re-read env vars (`DATABASE_PATH`, `SMELLGATE_CURATOR_DIDS`)
// from scratch. That also gives us fresh Kysely + better-sqlite3
// handles per test, so there's no shared state to leak between cases.
async function freshEnv(): Promise<{
  tap: TapModule;
  db: DbIndexModule;
  dbPath: string;
  dispose: () => void;
}> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-tap-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  vi.stubEnv("SMELLGATE_CURATOR_DIDS", CURATOR_DID);
  vi.resetModules();

  const migrations: MigrationsModule = await import("../../lib/db/migrations");
  const { error } = await migrations.getMigrator().migrateToLatest();
  if (error) throw error;

  const db: DbIndexModule = await import("../../lib/db");
  const tap: TapModule = await import("../../lib/tap/smellgate");

  return {
    tap,
    db,
    dbPath,
    dispose: () => {
      try {
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

// -------------------------------------------------------------------------
// Synthetic RecordEvent builders. These are plain objects that match the
// shape the Tap websocket would produce for a `create` event. Keeping
// them here (rather than in a shared fixtures module) makes each test
// read top-to-bottom with no hidden state.
// -------------------------------------------------------------------------

let rkeyCounter = 0;
function nextRkey(): string {
  rkeyCounter += 1;
  return `3jzfcijpj2z${rkeyCounter.toString().padStart(3, "0")}`;
}

function makeEvent(
  collection: string,
  did: string,
  record: Record<string, unknown>,
  opts: { action?: "create" | "update" | "delete"; cid?: string } = {},
): RecordEvent {
  return {
    id: rkeyCounter,
    type: "record",
    action: opts.action ?? "create",
    did,
    rev: "3kgabcdefgh2z",
    collection,
    rkey: nextRkey(),
    record,
    cid: opts.cid ?? FAKE_CID,
    live: true,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function strongRef(uri: string, cid: string = FAKE_CID2) {
  return { uri, cid };
}

// Any plausible perfume AT-URI. The dispatcher does not resolve strong
// refs to other rows; they are stored as opaque (uri, cid) pairs.
const PERFUME_REF_URI = `at://${CURATOR_DID}/app.smellgate.perfume/3jzfcijpj2zref`;
// Authored by a different user so USER_DID voting / commenting against
// it is not a self-vote / self-comment under the dispatcher guards
// (issues #191, #195).
const DESCRIPTION_REF_URI = `at://${OTHER_USER_DID}/app.smellgate.description/3jzfcijpj2zdref`;
const REVIEW_REF_URI = `at://${OTHER_USER_DID}/app.smellgate.review/3jzfcijpj2zrref`;
const SUBMISSION_REF_URI = `at://${USER_DID}/app.smellgate.perfumeSubmission/3jzfcijpj2zsref`;

// -------------------------------------------------------------------------

describe("dispatchSmellgateEvent", () => {
  let env: Awaited<ReturnType<typeof freshEnv>>;

  beforeEach(async () => {
    rkeyCounter = 0;
    env = await freshEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  // ---- happy-path: one row ends up in the right table ------------------

  describe("happy-path per record type", () => {
    it("indexes app.smellgate.perfume (curator-authored)", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.perfume, CURATOR_DID, {
        $type: NSID.perfume,
        name: "Aventus",
        house: "Creed",
        creator: "Olivier Creed",
        releaseYear: 2010,
        notes: ["pineapple", "birch", "musk"],
        description: "Legendary masculine.",
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const row = await db
        .selectFrom("smellgate_perfume")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.name).toBe("Aventus");
      expect(row.house).toBe("Creed");
      expect(row.creator).toBe("Olivier Creed");
      expect(row.release_year).toBe(2010);
      expect(row.author_did).toBe(CURATOR_DID);
      expect(row.cid).toBe(FAKE_CID);
    });

    it("indexes app.smellgate.perfumeSubmission (user-authored)", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.perfumeSubmission, USER_DID, {
        $type: NSID.perfumeSubmission,
        name: "Spicebomb",
        house: "Viktor & Rolf",
        notes: ["chili", "tobacco"],
        rationale: "Bought it yesterday, should be in the catalog.",
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const row = await db
        .selectFrom("smellgate_perfume_submission")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.name).toBe("Spicebomb");
      expect(row.rationale).toContain("yesterday");
      expect(row.author_did).toBe(USER_DID);
    });

    it("indexes app.smellgate.perfumeSubmissionResolution (curator-authored)", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(
        NSID.perfumeSubmissionResolution,
        CURATOR_DID,
        {
          $type: NSID.perfumeSubmissionResolution,
          submission: strongRef(SUBMISSION_REF_URI),
          decision: "approved",
          perfume: strongRef(PERFUME_REF_URI),
          note: "LGTM",
          createdAt: nowIso(),
        },
      );

      await env.tap.dispatchSmellgateEvent(db, evt);

      const row = await db
        .selectFrom("smellgate_perfume_submission_resolution")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.decision).toBe("approved");
      expect(row.submission_uri).toBe(SUBMISSION_REF_URI);
      expect(row.perfume_uri).toBe(PERFUME_REF_URI);
    });

    it("indexes app.smellgate.shelfItem", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.shelfItem, USER_DID, {
        $type: NSID.shelfItem,
        perfume: strongRef(PERFUME_REF_URI),
        acquiredAt: nowIso(),
        bottleSizeMl: 100,
        isDecant: false,
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const row = await db
        .selectFrom("smellgate_shelf_item")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.perfume_uri).toBe(PERFUME_REF_URI);
      expect(row.bottle_size_ml).toBe(100);
      expect(row.is_decant).toBe(0);
      expect(row.author_did).toBe(USER_DID);
    });

    it("indexes app.smellgate.review", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.review, USER_DID, {
        $type: NSID.review,
        perfume: strongRef(PERFUME_REF_URI),
        rating: 9,
        sillage: 4,
        longevity: 5,
        body: "Lovely.",
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const row = await db
        .selectFrom("smellgate_review")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.rating).toBe(9);
      expect(row.sillage).toBe(4);
      expect(row.longevity).toBe(5);
      expect(row.body).toBe("Lovely.");
    });

    it("indexes app.smellgate.description", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.description, USER_DID, {
        $type: NSID.description,
        perfume: strongRef(PERFUME_REF_URI),
        body: "Smells like a sunny day.",
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const row = await db
        .selectFrom("smellgate_description")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.body).toBe("Smells like a sunny day.");
      expect(row.perfume_uri).toBe(PERFUME_REF_URI);
    });

    it("indexes app.smellgate.vote", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.vote, USER_DID, {
        $type: NSID.vote,
        subject: strongRef(DESCRIPTION_REF_URI),
        direction: "up",
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const row = await db
        .selectFrom("smellgate_vote")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.direction).toBe("up");
      expect(row.subject_uri).toBe(DESCRIPTION_REF_URI);
    });

    it("indexes app.smellgate.comment", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.comment, USER_DID, {
        $type: NSID.comment,
        subject: strongRef(REVIEW_REF_URI),
        body: "Agreed, batch-dependent.",
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const row = await db
        .selectFrom("smellgate_comment")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.body).toContain("batch");
      expect(row.subject_uri).toBe(REVIEW_REF_URI);
    });
  });

  // ---- curator drop tests ---------------------------------------------

  describe("curator enforcement", () => {
    it("drops app.smellgate.perfume authored by a non-curator", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.perfume, USER_DID, {
        $type: NSID.perfume,
        name: "Fake Canonical",
        house: "Impostor",
        notes: ["vanilla"],
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const count = await db
        .selectFrom("smellgate_perfume")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(count.c)).toBe(0);
    });

    it("drops app.smellgate.perfumeSubmissionResolution authored by a non-curator", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.perfumeSubmissionResolution, USER_DID, {
        $type: NSID.perfumeSubmissionResolution,
        submission: strongRef(SUBMISSION_REF_URI),
        decision: "approved",
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const count = await db
        .selectFrom("smellgate_perfume_submission_resolution")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(count.c)).toBe(0);
    });

    it("indexes app.smellgate.perfume when the author IS a curator", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.perfume, CURATOR_DID, {
        $type: NSID.perfume,
        name: "Real Canonical",
        house: "Guerlain",
        notes: ["iris"],
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const row = await db
        .selectFrom("smellgate_perfume")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.name).toBe("Real Canonical");
    });

    it("indexes app.smellgate.perfumeSubmissionResolution when the author IS a curator", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.perfumeSubmissionResolution, CURATOR_DID, {
        $type: NSID.perfumeSubmissionResolution,
        submission: strongRef(SUBMISSION_REF_URI),
        decision: "rejected",
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const row = await db
        .selectFrom("smellgate_perfume_submission_resolution")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.decision).toBe("rejected");
    });
  });

  // ---- closed-enum drop tests -----------------------------------------

  describe("closed-enum enforcement", () => {
    it("drops a vote with an invalid direction", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.vote, USER_DID, {
        $type: NSID.vote,
        subject: strongRef(DESCRIPTION_REF_URI),
        direction: "sideways",
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const count = await db
        .selectFrom("smellgate_vote")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(count.c)).toBe(0);
    });

    it("drops a resolution with an invalid decision", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.perfumeSubmissionResolution, CURATOR_DID, {
        $type: NSID.perfumeSubmissionResolution,
        submission: strongRef(SUBMISSION_REF_URI),
        decision: "maybe",
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const count = await db
        .selectFrom("smellgate_perfume_submission_resolution")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(count.c)).toBe(0);
    });
  });

  // ---- lexicon validation drop ----------------------------------------

  describe("lexicon validation", () => {
    it("drops a review missing a required field (rating)", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.review, USER_DID, {
        $type: NSID.review,
        perfume: strongRef(PERFUME_REF_URI),
        // rating: missing
        sillage: 3,
        longevity: 3,
        body: "No rating, should be dropped.",
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const count = await db
        .selectFrom("smellgate_review")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(count.c)).toBe(0);
    });

    // Issues #188 / #197. Lexicon has no `pattern` on body, so the PDS
    // accepts NUL, BEL, ANSI escapes verbatim. The dispatcher drops
    // them rather than strip-rewriting (which would break the cid
    // round-trip against the PDS copy).
    it.each([
      ["review", NSID.review, "rev"],
      ["description", NSID.description, "desc"],
      ["comment", NSID.comment, "com"],
    ])(
      "drops app.smellgate.%s whose body contains C0 control chars",
      async (_label, nsid, kind) => {
        const db = env.db.getDb();
        let fullRecord: Record<string, unknown>;
        if (kind === "rev") {
          fullRecord = {
            $type: nsid,
            perfume: strongRef(PERFUME_REF_URI),
            rating: 8,
            sillage: 3,
            longevity: 3,
            body: "hostile\u0000NUL\u001b[31mred\u001b[0m",
            createdAt: nowIso(),
          };
        } else if (kind === "desc") {
          fullRecord = {
            $type: nsid,
            perfume: strongRef(PERFUME_REF_URI),
            body: "hostile\u0000NUL\u0007BEL",
            createdAt: nowIso(),
          };
        } else {
          fullRecord = {
            $type: nsid,
            subject: strongRef(REVIEW_REF_URI),
            body: "hostile\u001b[2Jclear",
            createdAt: nowIso(),
          };
        }

        await env.tap.dispatchSmellgateEvent(db, makeEvent(nsid, USER_DID, fullRecord));

        const tableName =
          kind === "rev"
            ? "smellgate_review"
            : kind === "desc"
              ? "smellgate_description"
              : "smellgate_comment";
        const count = await db
          .selectFrom(tableName as "smellgate_review")
          .select(db.fn.countAll<number>().as("c"))
          .executeTakeFirstOrThrow();
        expect(Number(count.c)).toBe(0);
      },
    );
  });

  // ---- note tag denormalization ---------------------------------------

  describe("note tag denormalization", () => {
    it("writes one row per (perfume_uri, note) for smellgate_perfume_note", async () => {
      const db = env.db.getDb();
      const evt = makeEvent(NSID.perfume, CURATOR_DID, {
        $type: NSID.perfume,
        name: "Oud Rose",
        house: "Test House",
        notes: ["rose", "oud", "amber"],
        createdAt: nowIso(),
      });

      await env.tap.dispatchSmellgateEvent(db, evt);

      const perfumeRow = await db
        .selectFrom("smellgate_perfume")
        .select("uri")
        .executeTakeFirstOrThrow();
      const rows = await db
        .selectFrom("smellgate_perfume_note")
        .selectAll()
        .where("perfume_uri", "=", perfumeRow.uri)
        .orderBy("note")
        .execute();
      expect(rows.map((r) => r.note)).toEqual(["amber", "oud", "rose"]);
      expect(rows).toHaveLength(3);
    });
  });
});

