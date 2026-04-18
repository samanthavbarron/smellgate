/**
 * Integration test for `scripts/rebuild-cache.ts`.
 *
 * The whole point of this test is to PROVE that the smellgate read
 * cache can be reconstructed entirely from what lives in the PDS
 * network. Per AGENTS.md: "The only local storage is the auth session
 * store and a Tap-fed read cache — never treat it as authoritative."
 * If this test passes, the cache is genuinely a cache.
 *
 * Shape of the test:
 *
 *   1. Start an in-process PDS + PLC via `tests/helpers/pds.ts`.
 *   2. Seed two accounts — a curator (alice) and a regular user (bob).
 *      The curator DID is injected into the process environment via
 *      `SMELLGATE_CURATOR_DIDS` before the Tap dispatcher module is
 *      loaded, so the real `isCurator()` gate accepts her records.
 *   3. Write a known set of `app.smellgate.*` records to each PDS repo
 *      using `com.atproto.repo.createRecord` authenticated with the
 *      SeedClient-issued JWTs. (Using OAuth here would be overkill —
 *      `oauth-pds.test.ts` already covers that path; this test is
 *      about rebuild, not auth.)
 *   4. Populate the local SQLite cache by dispatching synthetic
 *      RecordEvents for each written record — the same path the
 *      production webhook takes.
 *   5. Snapshot the cache (counts per table, sample rows).
 *   6. Run the rebuild script's drop step → assert the cache is empty.
 *   7. Run the rebuild script's rebuild step, pointing it at the
 *      in-process PDS and passing the explicit DID list so the test
 *      doesn't depend on the "walk the old cache for DIDs" path (which
 *      would be impossible after step 6 anyway — that's the point).
 *   8. Assert the rebuilt cache contents match the snapshot exactly.
 *
 * NO MOCKS. Real PDS, real dispatcher, real Kysely, real script.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordEvent } from "@atproto/tap";
import {
  type EphemeralPds,
  createTestAccounts,
  startEphemeralPds,
  stopEphemeralPds,
  type TestAccountCreds,
} from "../helpers/pds";

// Module types — loaded dynamically after env-var stubbing, same
// pattern as `tap-smellgate-cache.test.ts`.
type RebuildModule = typeof import("../../scripts/rebuild-cache");
type TapModule = typeof import("../../lib/tap/smellgate");
type DbIndexModule = typeof import("../../lib/db");
type MigrationsModule = typeof import("../../lib/db/migrations");

type TestEnv = {
  rebuild: RebuildModule;
  tap: TapModule;
  db: DbIndexModule;
  dispose: () => void;
};

/**
 * Set up a fresh SQLite file with the smellgate schema migrated, pinned
 * curator DIDs, and freshly-imported modules (so the in-module cache of
 * `CURATOR_DIDS` captures the right value). Called per test so there's
 * no cross-test bleed.
 */
async function freshEnv(curatorDid: string): Promise<TestEnv> {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-rebuild-"));
  const dbPath = path.join(dbDir, "cache.db");
  vi.stubEnv("DATABASE_PATH", dbPath);
  vi.stubEnv("SMELLGATE_CURATOR_DIDS", curatorDid);
  vi.resetModules();

  const migrations: MigrationsModule = await import("../../lib/db/migrations");
  const { error } = await migrations.getMigrator().migrateToLatest();
  if (error) throw error;

  const db: DbIndexModule = await import("../../lib/db");
  const tap: TapModule = await import("../../lib/tap/smellgate");
  const rebuild: RebuildModule = await import("../../scripts/rebuild-cache");
  return {
    rebuild,
    tap,
    db,
    dispose: () => {
      try {
        fs.rmSync(dbDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// PDS writer. Uses `com.atproto.repo.createRecord` over plain fetch with
// the SeedClient-issued access JWT — no OAuth, no @atproto/api import.
// ---------------------------------------------------------------------------

type CreatedRecord = {
  uri: string;
  cid: string;
  collection: string;
  did: string;
  record: Record<string, unknown>;
};

async function createRecord(
  pds: EphemeralPds,
  auth: TestAccountCreds,
  collection: string,
  record: Record<string, unknown>,
): Promise<CreatedRecord> {
  const res = await fetch(`${pds.url}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${auth.accessJwt}`,
    },
    body: JSON.stringify({
      repo: auth.did,
      collection,
      record,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `createRecord failed ${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { uri: string; cid: string };
  return { uri: body.uri, cid: body.cid, collection, did: auth.did, record };
}

function makeRecordEvent(cr: CreatedRecord): RecordEvent {
  // at://did/collection/rkey
  const rkey = cr.uri.split("/").pop()!;
  return {
    id: 0,
    type: "record",
    action: "create",
    did: cr.did,
    rev: "test",
    collection: cr.collection,
    rkey,
    record: cr.record,
    cid: cr.cid,
    live: true,
  };
}

// ---------------------------------------------------------------------------

describe("cache rebuild from network", () => {
  let pds: EphemeralPds;
  let accounts: TestAccountCreds[];
  let curator: TestAccountCreds;
  let user: TestAccountCreds;

  beforeAll(async () => {
    pds = await startEphemeralPds();
    accounts = await createTestAccounts(pds);
    const alice = accounts.find((a) => a.shortName === "alice");
    const bob = accounts.find((a) => a.shortName === "bob");
    if (!alice || !bob) throw new Error("seed accounts missing");
    curator = alice;
    user = bob;
  }, 120_000);

  afterAll(async () => {
    if (pds) await stopEphemeralPds(pds);
  });

  let env: TestEnv;

  beforeEach(async () => {
    env = await freshEnv(curator.did);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  it(
    "rebuilds the cache from per-DID listRecords after a drop",
    async () => {
      // ------------------------------------------------------------
      // 1. Write a known set of records to the PDS.
      //
      // Curator writes one canonical perfume. User writes one
      // submission, one shelf item, one review, one description, one
      // vote (on the description), and one comment (on the review).
      // We deliberately mix curator-only and user records to exercise
      // the `isCurator` gate during rebuild.
      // ------------------------------------------------------------
      const nowIso = () => new Date().toISOString();

      const perfume = await createRecord(
        pds,
        curator,
        "app.smellgate.perfume",
        {
          $type: "app.smellgate.perfume",
          name: "Aventus",
          house: "Creed",
          creator: "Olivier Creed",
          releaseYear: 2010,
          notes: ["pineapple", "birch", "musk"],
          description: "Legendary masculine.",
          createdAt: nowIso(),
        },
      );

      const submission = await createRecord(
        pds,
        user,
        "app.smellgate.perfumeSubmission",
        {
          $type: "app.smellgate.perfumeSubmission",
          name: "Spicebomb",
          house: "Viktor & Rolf",
          notes: ["chili", "tobacco"],
          rationale: "Bought it yesterday.",
          createdAt: nowIso(),
        },
      );

      const shelfItem = await createRecord(
        pds,
        user,
        "app.smellgate.shelfItem",
        {
          $type: "app.smellgate.shelfItem",
          perfume: { uri: perfume.uri, cid: perfume.cid },
          acquiredAt: nowIso(),
          bottleSizeMl: 100,
          isDecant: false,
          createdAt: nowIso(),
        },
      );

      const review = await createRecord(pds, user, "app.smellgate.review", {
        $type: "app.smellgate.review",
        perfume: { uri: perfume.uri, cid: perfume.cid },
        rating: 9,
        sillage: 4,
        longevity: 5,
        body: "Lovely.",
        createdAt: nowIso(),
      });

      const description = await createRecord(
        pds,
        user,
        "app.smellgate.description",
        {
          $type: "app.smellgate.description",
          perfume: { uri: perfume.uri, cid: perfume.cid },
          body: "Smells like a sunny day.",
          createdAt: nowIso(),
        },
      );

      // Vote is cast by the curator account against the user's
      // description so the dispatcher's self-vote guard (#191) doesn't
      // drop it. The curator gate does not apply to votes — any
      // authenticated author can vote on any other author's
      // description.
      const vote = await createRecord(pds, curator, "app.smellgate.vote", {
        $type: "app.smellgate.vote",
        subject: { uri: description.uri, cid: description.cid },
        direction: "up",
        createdAt: nowIso(),
      });

      const comment = await createRecord(pds, user, "app.smellgate.comment", {
        $type: "app.smellgate.comment",
        subject: { uri: review.uri, cid: review.cid },
        body: "Agreed.",
        createdAt: nowIso(),
      });

      const allCreated: CreatedRecord[] = [
        perfume,
        submission,
        shelfItem,
        review,
        description,
        vote,
        comment,
      ];

      // ------------------------------------------------------------
      // 2. Populate the local cache by dispatching synthetic
      // RecordEvents — same code path the production webhook takes.
      // ------------------------------------------------------------
      const db = env.db.getDb();
      for (const cr of allCreated) {
        await env.tap.dispatchSmellgateEvent(db, makeRecordEvent(cr));
      }

      // ------------------------------------------------------------
      // 3. Snapshot the populated cache. We assert counts by table and
      // capture primary-key lists so we can compare exactly after
      // rebuild — not just "the row count matched".
      // ------------------------------------------------------------
      const snapshot = await snapshotCache(db);
      expect(snapshot.counts.smellgate_perfume).toBe(1);
      expect(snapshot.counts.smellgate_perfume_submission).toBe(1);
      expect(snapshot.counts.smellgate_shelf_item).toBe(1);
      expect(snapshot.counts.smellgate_review).toBe(1);
      expect(snapshot.counts.smellgate_description).toBe(1);
      expect(snapshot.counts.smellgate_vote).toBe(1);
      expect(snapshot.counts.smellgate_comment).toBe(1);
      expect(snapshot.counts.smellgate_perfume_note).toBe(3); // pineapple, birch, musk
      expect(snapshot.counts.smellgate_perfume_submission_note).toBe(2); // chili, tobacco

      // ------------------------------------------------------------
      // 4. Drop the cache. Assert empty.
      // ------------------------------------------------------------
      await env.rebuild.dropAllCacheRows(db);
      const emptied = await snapshotCache(db);
      for (const v of Object.values(emptied.counts)) expect(v).toBe(0);

      // ------------------------------------------------------------
      // 5. Rebuild from the network. We pass an explicit DID list
      // (curator + user) because after the drop the cache-walk path
      // would find nothing — exactly the scenario the issue calls out.
      // ------------------------------------------------------------
      const report = await env.rebuild.rebuildCache(db, {
        pdsUrl: pds.url,
        dryRun: false,
        dids: [curator.did, user.did],
        log: () => {
          /* silence in-test */
        },
      });
      expect(report.dryRun).toBe(false);
      expect(report.didsConsidered).toBe(2);
      expect(report.dispatched).toBe(allCreated.length);

      // ------------------------------------------------------------
      // 6. The rebuilt cache must match the original snapshot.
      // ------------------------------------------------------------
      const rebuilt = await snapshotCache(db);
      expect(rebuilt.counts).toEqual(snapshot.counts);
      expect(rebuilt.uris.smellgate_perfume).toEqual(
        snapshot.uris.smellgate_perfume,
      );
      expect(rebuilt.uris.smellgate_perfume_submission).toEqual(
        snapshot.uris.smellgate_perfume_submission,
      );
      expect(rebuilt.uris.smellgate_shelf_item).toEqual(
        snapshot.uris.smellgate_shelf_item,
      );
      expect(rebuilt.uris.smellgate_review).toEqual(
        snapshot.uris.smellgate_review,
      );
      expect(rebuilt.uris.smellgate_description).toEqual(
        snapshot.uris.smellgate_description,
      );
      expect(rebuilt.uris.smellgate_vote).toEqual(snapshot.uris.smellgate_vote);
      expect(rebuilt.uris.smellgate_comment).toEqual(
        snapshot.uris.smellgate_comment,
      );

      // Spot-check a content field on the rebuilt perfume to prove it
      // round-tripped through lexicon validation, not just an opaque
      // pass-through.
      const rebuiltPerfume = await db
        .selectFrom("smellgate_perfume")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(rebuiltPerfume.name).toBe("Aventus");
      expect(rebuiltPerfume.house).toBe("Creed");
      expect(rebuiltPerfume.author_did).toBe(curator.did);
    },
    120_000,
  );

  it("dry-run reports counts without dropping the cache", async () => {
    // Minimal sanity check: populate one row, run a dry-run rebuild,
    // verify the row is still there and the report lists 1 record.
    const perfume = await createRecord(pds, curator, "app.smellgate.perfume", {
      $type: "app.smellgate.perfume",
      name: "Dry Run Rose",
      house: "Test",
      notes: ["rose"],
      createdAt: new Date().toISOString(),
    });

    const db = env.db.getDb();
    await env.tap.dispatchSmellgateEvent(db, makeRecordEvent(perfume));

    const before = await snapshotCache(db);
    expect(before.counts.smellgate_perfume).toBe(1);

    const report = await env.rebuild.rebuildCache(db, {
      pdsUrl: pds.url,
      dryRun: true,
      dids: [curator.did],
      log: () => {},
    });
    expect(report.dryRun).toBe(true);
    expect(report.dispatched).toBe(0);
    expect(report.listedRecords).toBeGreaterThanOrEqual(1);

    const after = await snapshotCache(db);
    expect(after.counts).toEqual(before.counts);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Cache snapshot helper — captures counts and primary-key lists across
// every smellgate_* table so tests can assert "before" vs "after".
// ---------------------------------------------------------------------------

type Snapshot = {
  counts: Record<string, number>;
  uris: Record<string, string[]>;
};

async function snapshotCache(
  db: import("kysely").Kysely<
    import("../../lib/db").DatabaseSchema
  >,
): Promise<Snapshot> {
  const counts: Record<string, number> = {};
  const uris: Record<string, string[]> = {};

  // Tables with a `uri` PK.
  for (const t of [
    "smellgate_perfume",
    "smellgate_perfume_submission",
    "smellgate_perfume_submission_resolution",
    "smellgate_shelf_item",
    "smellgate_review",
    "smellgate_description",
    "smellgate_vote",
    "smellgate_comment",
  ] as const) {
    const rows = await db.selectFrom(t).select("uri").orderBy("uri").execute();
    counts[t] = rows.length;
    uris[t] = rows.map((r) => r.uri);
  }

  // Join tables use composite PKs; just record counts.
  const perfumeNotes = await db
    .selectFrom("smellgate_perfume_note")
    .selectAll()
    .execute();
  counts["smellgate_perfume_note"] = perfumeNotes.length;
  const submissionNotes = await db
    .selectFrom("smellgate_perfume_submission_note")
    .selectAll()
    .execute();
  counts["smellgate_perfume_submission_note"] = submissionNotes.length;

  return { counts, uris };
}
