/**
 * Integration tests for the dispatcher-layer symmetric guards
 * (bugbash issues #168, #180, #183, #185, #189, #191, #194, #195).
 *
 * Background: PRs #143 / #160 added guards at the server-action layer
 * (`lib/server/smellgate-actions.ts`): normalization, HTML sanitization,
 * self-vote reject, duplicate-vote cleanup, collection-kind rejection
 * for strongRefs, body trim / minLength / maxGraphemes. Those guards
 * only fire on writes that go through the `/api/smellgate/*` route
 * handlers. Real atproto clients can write directly to the user's PDS
 * and bypass them entirely.
 *
 * The Tap dispatcher is the last line of defense before bad data
 * reaches the read cache. These tests cover the symmetric guards the
 * dispatcher now applies:
 *
 *   - shelfItem / review / description: `perfume.uri` collection must
 *     be `app.smellgate.perfume` (not perfumeSubmission, not anything
 *     else). Dropped otherwise.
 *   - vote: `subject.uri` collection must be `app.smellgate.description`.
 *     Self-vote (author DID == subject-URI authority DID) is dropped.
 *     A duplicate `(author_did, subject_uri)` deletes the prior cache
 *     row before inserting the new one.
 *   - comment: `subject.uri` collection must be `app.smellgate.review`.
 *   - review / description / comment body: rejected if whitespace-only
 *     after trim, or if graphemes-over-max.
 *
 * We reuse the same `freshEnv` helper pattern from
 * `tap-smellgate-cache.test.ts` so each case gets its own migrated
 * SQLite file and its own module graph (which means fresh
 * `SMELLGATE_CURATOR_DIDS` / `DATABASE_PATH` reads).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordEvent } from "@atproto/tap";

const CURATOR_DID = "did:plc:alicecurator01";
const USER_DID = "did:plc:bobuser01";
const OTHER_USER_DID = "did:plc:caroluser02";

const NSID = {
  perfume: "app.smellgate.perfume",
  perfumeSubmission: "app.smellgate.perfumeSubmission",
  shelfItem: "app.smellgate.shelfItem",
  review: "app.smellgate.review",
  description: "app.smellgate.description",
  vote: "app.smellgate.vote",
  comment: "app.smellgate.comment",
} as const;

const FAKE_CID = "bafkreic34bborvtv2pquhi5vt3yjjuhzdhmlnqx263wmc3br2fu63evfiy";
const FAKE_CID2 = "bafkreicecy4kathmioy72xvtl7l2wjbfkdxe7zimlvf6tbqzsd6mofoeiy";

type TapModule = typeof import("../../lib/tap/smellgate");
type DbIndexModule = typeof import("../../lib/db");
type MigrationsModule = typeof import("../../lib/db/migrations");

async function freshEnv(): Promise<{
  tap: TapModule;
  db: DbIndexModule;
  dispose: () => void;
}> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-tap-guards-")),
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
    dispose: () => {
      try {
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

let rkeyCounter = 0;
function nextRkey(): string {
  rkeyCounter += 1;
  return `3jzfcijpj2z${rkeyCounter.toString().padStart(3, "0")}`;
}

function makeEvent(
  collection: string,
  did: string,
  record: Record<string, unknown>,
  opts: { action?: "create" | "update" | "delete"; cid?: string; rkey?: string } = {},
): RecordEvent {
  return {
    id: rkeyCounter,
    type: "record",
    action: opts.action ?? "create",
    did,
    rev: "3kgabcdefgh2z",
    collection,
    rkey: opts.rkey ?? nextRkey(),
    record,
    cid: opts.cid ?? FAKE_CID,
    live: true,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function ref(uri: string, cid: string = FAKE_CID2) {
  return { uri, cid };
}

// Useful URIs. The dispatcher doesn't join these against other cache
// rows at index time — it only looks at the AT-URI structure — so the
// rkeys don't need to correspond to real records.
const PERFUME_URI = `at://${CURATOR_DID}/app.smellgate.perfume/3jzfcijpj2zref`;
const SUBMISSION_URI = `at://${USER_DID}/app.smellgate.perfumeSubmission/3jzfcijpj2zsub`;
const DESCRIPTION_URI_BY_OTHER = `at://${OTHER_USER_DID}/app.smellgate.description/3jzfcijpj2zdr1`;
const DESCRIPTION_URI_BY_SELF = `at://${USER_DID}/app.smellgate.description/3jzfcijpj2zdr2`;
const REVIEW_URI = `at://${USER_DID}/app.smellgate.review/3jzfcijpj2zrv1`;
const COMMENT_URI = `at://${USER_DID}/app.smellgate.comment/3jzfcijpj2zcm1`;

describe("dispatchSmellgateEvent — symmetric guards", () => {
  let env: Awaited<ReturnType<typeof freshEnv>>;

  beforeEach(async () => {
    rkeyCounter = 0;
    env = await freshEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  // ---- shelfItem.perfume collection gate (#168) -----------------------

  describe("shelfItem.perfume collection gate (#168)", () => {
    it("drops a shelfItem whose perfume.uri points at a perfumeSubmission", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.shelfItem, USER_DID, {
          $type: NSID.shelfItem,
          perfume: ref(SUBMISSION_URI),
          createdAt: nowIso(),
        }),
      );

      const c = await db
        .selectFrom("smellgate_shelf_item")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });

    it("drops a shelfItem whose perfume.uri points at a review", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.shelfItem, USER_DID, {
          $type: NSID.shelfItem,
          perfume: ref(REVIEW_URI),
          createdAt: nowIso(),
        }),
      );

      const c = await db
        .selectFrom("smellgate_shelf_item")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });

    it("indexes a shelfItem whose perfume.uri points at a perfume", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.shelfItem, USER_DID, {
          $type: NSID.shelfItem,
          perfume: ref(PERFUME_URI),
          createdAt: nowIso(),
        }),
      );

      const c = await db
        .selectFrom("smellgate_shelf_item")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(1);
    });
  });

  // ---- review.perfume collection + body gates (#194, #193, #189) -----

  describe("review.perfume collection gate (#194)", () => {
    it("drops a review whose perfume.uri points at a perfumeSubmission", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.review, USER_DID, {
          $type: NSID.review,
          perfume: ref(SUBMISSION_URI),
          rating: 8,
          sillage: 3,
          longevity: 3,
          body: "Nice one.",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_review")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });
  });

  describe("review body gate (#193, #189)", () => {
    it("drops a review with a whitespace-only body", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.review, USER_DID, {
          $type: NSID.review,
          perfume: ref(PERFUME_URI),
          rating: 8,
          sillage: 3,
          longevity: 3,
          body: "   \t\n  ",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_review")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });

    it("drops a review whose body exceeds the lexicon maxGraphemes", async () => {
      const db = env.db.getDb();
      // review maxGraphemes is 15000; 15001 chars is just-over.
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.review, USER_DID, {
          $type: NSID.review,
          perfume: ref(PERFUME_URI),
          rating: 8,
          sillage: 3,
          longevity: 3,
          body: "x".repeat(15001),
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_review")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });
  });

  // ---- description.perfume + body (#180, #185, #189) -------------------

  describe("description.perfume collection gate (#180)", () => {
    it("drops a description whose perfume.uri points at a perfumeSubmission", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.description, USER_DID, {
          $type: NSID.description,
          perfume: ref(SUBMISSION_URI),
          body: "Pretending this submission is a perfume.",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_description")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });
  });

  describe("description body gate (#185, #189)", () => {
    it("drops a description with a whitespace-only body", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.description, USER_DID, {
          $type: NSID.description,
          perfume: ref(PERFUME_URI),
          body: "    \t\n ",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_description")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });

    it("drops a description whose body exceeds the lexicon maxGraphemes", async () => {
      const db = env.db.getDb();
      // description maxGraphemes is 5000; 5001 is just-over.
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.description, USER_DID, {
          $type: NSID.description,
          perfume: ref(PERFUME_URI),
          body: "a".repeat(5001),
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_description")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });

    it("indexes a description with a body exactly at the lexicon max", async () => {
      const db = env.db.getDb();
      // Exactly 5000 graphemes should pass.
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.description, USER_DID, {
          $type: NSID.description,
          perfume: ref(PERFUME_URI),
          body: "a".repeat(5000),
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_description")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(1);
    });
  });

  // ---- vote.subject collection + self-vote + duplicate (#183, #191) ---

  describe("vote.subject collection gate (#183)", () => {
    it("drops a vote whose subject.uri points at a perfume", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.vote, USER_DID, {
          $type: NSID.vote,
          subject: ref(PERFUME_URI),
          direction: "up",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_vote")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });

    it("drops a vote whose subject.uri points at a review", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.vote, USER_DID, {
          $type: NSID.vote,
          subject: ref(REVIEW_URI),
          direction: "up",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_vote")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });
  });

  describe("self-vote guard (#191a)", () => {
    it("drops a vote where the author DID equals the description author DID", async () => {
      const db = env.db.getDb();
      // subject authored by USER_DID; voter is USER_DID. Drop.
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.vote, USER_DID, {
          $type: NSID.vote,
          subject: ref(DESCRIPTION_URI_BY_SELF),
          direction: "up",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_vote")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });

    it("indexes a vote where the author DID differs from the description author DID", async () => {
      const db = env.db.getDb();
      // subject authored by OTHER_USER_DID; voter is USER_DID. Keep.
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.vote, USER_DID, {
          $type: NSID.vote,
          subject: ref(DESCRIPTION_URI_BY_OTHER),
          direction: "up",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_vote")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(1);
    });
  });

  describe("duplicate-vote cleanup (#191b)", () => {
    it("deletes a prior vote on the same (author_did, subject_uri) before inserting the new one", async () => {
      const db = env.db.getDb();

      // First vote from USER_DID against OTHER_USER_DID's description.
      const firstRkey = "3jzfcijpj2zfirst";
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(
          NSID.vote,
          USER_DID,
          {
            $type: NSID.vote,
            subject: ref(DESCRIPTION_URI_BY_OTHER),
            direction: "up",
            createdAt: nowIso(),
          },
          { rkey: firstRkey, cid: FAKE_CID },
        ),
      );

      // Second vote — same author, same subject, different rkey.
      const secondRkey = "3jzfcijpj2zsecnd";
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(
          NSID.vote,
          USER_DID,
          {
            $type: NSID.vote,
            subject: ref(DESCRIPTION_URI_BY_OTHER),
            direction: "down",
            createdAt: nowIso(),
          },
          { rkey: secondRkey, cid: FAKE_CID2 },
        ),
      );

      const rows = await db
        .selectFrom("smellgate_vote")
        .selectAll()
        .where("author_did", "=", USER_DID)
        .where("subject_uri", "=", DESCRIPTION_URI_BY_OTHER)
        .execute();
      // Only the second vote should survive.
      expect(rows).toHaveLength(1);
      expect(rows[0].direction).toBe("down");
      expect(rows[0].uri.endsWith(secondRkey)).toBe(true);
    });

    it("does not delete votes from other authors on the same subject", async () => {
      const db = env.db.getDb();

      // Vote from OTHER_USER_DID (on their own description is a
      // self-vote — drop). Use a third DID against the OTHER_USER_DID
      // description instead.
      const thirdDid = "did:plc:thirduser03";
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.vote, thirdDid, {
          $type: NSID.vote,
          subject: ref(DESCRIPTION_URI_BY_OTHER),
          direction: "up",
          createdAt: nowIso(),
        }),
      );

      // New vote from USER_DID on the same subject — should leave the
      // third-party vote alone.
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.vote, USER_DID, {
          $type: NSID.vote,
          subject: ref(DESCRIPTION_URI_BY_OTHER),
          direction: "up",
          createdAt: nowIso(),
        }),
      );

      const rows = await db
        .selectFrom("smellgate_vote")
        .selectAll()
        .where("subject_uri", "=", DESCRIPTION_URI_BY_OTHER)
        .execute();
      expect(rows.map((r) => r.author_did).sort()).toEqual(
        [USER_DID, thirdDid].sort(),
      );
    });
  });

  // ---- comment.subject collection + body (#195, #196) ----------------

  describe("comment.subject collection gate (#195)", () => {
    it("drops a comment whose subject.uri points at a perfume", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.comment, USER_DID, {
          $type: NSID.comment,
          subject: ref(PERFUME_URI),
          body: "Great scent.",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_comment")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });

    it("drops a comment whose subject.uri points at another comment (no nesting)", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.comment, USER_DID, {
          $type: NSID.comment,
          subject: ref(COMMENT_URI),
          body: "Reply on reply — disallowed.",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_comment")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });

    it("indexes a comment whose subject.uri points at a review", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.comment, USER_DID, {
          $type: NSID.comment,
          subject: ref(REVIEW_URI),
          body: "Good review.",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_comment")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(1);
    });
  });

  describe("comment body gate (#196)", () => {
    it("drops a comment with a whitespace-only body", async () => {
      const db = env.db.getDb();
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.comment, USER_DID, {
          $type: NSID.comment,
          subject: ref(REVIEW_URI),
          body: "   \t\n ",
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_comment")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });

    it("drops a comment whose body exceeds the lexicon maxGraphemes", async () => {
      const db = env.db.getDb();
      // comment maxGraphemes is 5000; 5001 is just-over.
      await env.tap.dispatchSmellgateEvent(
        db,
        makeEvent(NSID.comment, USER_DID, {
          $type: NSID.comment,
          subject: ref(REVIEW_URI),
          body: "y".repeat(5001),
          createdAt: nowIso(),
        }),
      );
      const c = await db
        .selectFrom("smellgate_comment")
        .select(db.fn.countAll<number>().as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(c.c)).toBe(0);
    });
  });
});
