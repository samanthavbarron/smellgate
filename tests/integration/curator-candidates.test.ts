/**
 * Integration test for the curator duplicate-picker typeahead backend
 * (issue #139): `listCanonicalCandidatesAction` + the route at
 * `GET /api/smellgate/curator/search`.
 *
 * The underlying `searchPerfumes` is already extensively unit-tested
 * (LIKE-escape safety, name/house/creator/notes matching, pagination,
 * NULL handling). This test covers the curator-side wrapper:
 *
 *   1. The action is curator-gated: non-curator sessions get 403.
 *   2. Returns candidates in the tight wire shape (no notes, no
 *      author, etc.), mapping `release_year` → `releaseYear`.
 *   3. Honors the default limit of 5 and caps at 25 regardless of what
 *      the caller requests.
 *   4. Empty / whitespace query short-circuits to `candidates: []`.
 *   5. No matches returns an empty list (the UI hint path).
 *
 * Runs against real migrations + a real SQLite tmp file + real
 * `lib/curators.ts` — the same setup Phase 2.B's unit-query test uses.
 * No OAuth / PDS: the action only reads `session.did`, so a hand-rolled
 * session stub is sufficient. This matches the existing convention in
 * `tests/integration/curator-submission-flow.test.ts` which also
 * injects session-shaped objects where only the DID matters; here we
 * avoid the PDS ceremony because the action has no write side.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthSession } from "@atproto/oauth-client-node";

type CuratorModule =
  typeof import("../../lib/server/smellgate-curator-actions");
type DbIndexModule = typeof import("../../lib/db");
type MigrationsModule = typeof import("../../lib/db/migrations");

const CURATOR = "did:plc:curator00000";
const NON_CURATOR = "did:plc:notcurator00";

async function freshEnv(): Promise<{
  curator: CuratorModule;
  db: DbIndexModule;
  dispose: () => void;
}> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-cand-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  vi.stubEnv("SMELLGATE_CURATOR_DIDS", CURATOR);
  vi.resetModules();

  const migrations: MigrationsModule = await import("../../lib/db/migrations");
  const { error } = await migrations.getMigrator().migrateToLatest();
  if (error) throw error;

  const db: DbIndexModule = await import("../../lib/db");
  const curator: CuratorModule = await import(
    "../../lib/server/smellgate-curator-actions"
  );
  return {
    curator,
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

let seq = 0;
function nextIndexedAt(): number {
  seq += 1;
  return 1_700_000_000_000 + seq;
}

async function seedPerfume(
  db: DbIndexModule,
  seed: {
    name: string;
    house: string;
    creator?: string | null;
    releaseYear?: number | null;
    notes?: string[];
  },
): Promise<string> {
  seq += 1;
  const uri = `at://${CURATOR}/app.smellgate.perfume/p${seq}`;
  const indexedAt = nextIndexedAt();
  await db
    .getDb()
    .insertInto("smellgate_perfume")
    .values({
      uri,
      cid: "bafkreic0000000fake000cid00000000000000000000000000000000",
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
      .values(seed.notes.map((note) => ({ perfume_uri: uri, note })))
      .execute();
  }
  return uri;
}

function sessionFor(did: string): OAuthSession {
  // The action reads only `session.did`; everything else is irrelevant
  // for this entry point. Casting through `unknown` here is a loud,
  // local, test-only compromise — the production type is a full
  // `OAuthSession` that would require a full PDS + OAuth flow to
  // construct, which this test deliberately skips.
  return { did } as unknown as OAuthSession;
}

describe("listCanonicalCandidatesAction (#139)", () => {
  let env: Awaited<ReturnType<typeof freshEnv>>;

  beforeEach(async () => {
    env = await freshEnv();
  });
  afterEach(() => {
    env.dispose();
    vi.unstubAllEnvs();
  });

  it("denies non-curator sessions with a 403 ActionError", async () => {
    await expect(
      env.curator.listCanonicalCandidatesAction(
        env.db.getDb(),
        sessionFor(NON_CURATOR),
        { query: "anything" },
      ),
    ).rejects.toMatchObject({ name: "ActionError", status: 403 });
  });

  it("returns candidates in the tight wire shape with camelCased releaseYear", async () => {
    await seedPerfume(env.db, {
      name: "Vespertine",
      house: "Oriza L. Legrand",
      creator: "Jean-Claude Ellena",
      releaseYear: 2011,
      notes: ["iris", "ambergris"],
    });

    const res = await env.curator.listCanonicalCandidatesAction(
      env.db.getDb(),
      sessionFor(CURATOR),
      { query: "Vespertine" },
    );

    expect(res.candidates).toHaveLength(1);
    const row = res.candidates[0]!;
    expect(row).toEqual({
      uri: expect.stringContaining("app.smellgate.perfume"),
      name: "Vespertine",
      house: "Oriza L. Legrand",
      creator: "Jean-Claude Ellena",
      releaseYear: 2011,
    });
    // Wire shape: no notes, no description, no author — trimmed for
    // the typeahead's purposes.
    expect(row).not.toHaveProperty("notes");
    expect(row).not.toHaveProperty("description");
    expect(row).not.toHaveProperty("author_did");
    expect(row).not.toHaveProperty("release_year");
  });

  it("defaults the limit to 5 and caps an over-large limit at 25", async () => {
    // Seed 30 matches on the substring "rose".
    for (let i = 0; i < 30; i += 1) {
      await seedPerfume(env.db, {
        name: `Rose ${String(i).padStart(2, "0")}`,
        house: "H",
      });
    }
    const defaulted = await env.curator.listCanonicalCandidatesAction(
      env.db.getDb(),
      sessionFor(CURATOR),
      { query: "rose" },
    );
    expect(defaulted.candidates).toHaveLength(5);

    const capped = await env.curator.listCanonicalCandidatesAction(
      env.db.getDb(),
      sessionFor(CURATOR),
      { query: "rose", limit: 9999 },
    );
    expect(capped.candidates).toHaveLength(25);
  });

  it("returns an empty candidate list for an empty / whitespace query", async () => {
    await seedPerfume(env.db, { name: "Vespertine", house: "Oriza" });
    expect(
      (
        await env.curator.listCanonicalCandidatesAction(
          env.db.getDb(),
          sessionFor(CURATOR),
          { query: "" },
        )
      ).candidates,
    ).toEqual([]);
    expect(
      (
        await env.curator.listCanonicalCandidatesAction(
          env.db.getDb(),
          sessionFor(CURATOR),
          { query: "   " },
        )
      ).candidates,
    ).toEqual([]);
  });

  it("returns an empty candidate list when the substring matches nothing", async () => {
    await seedPerfume(env.db, { name: "Vespertine", house: "Oriza" });
    const res = await env.curator.listCanonicalCandidatesAction(
      env.db.getDb(),
      sessionFor(CURATOR),
      { query: "xyzzy-no-match" },
    );
    expect(res.candidates).toEqual([]);
  });

  it("matches name/house/creator/notes via the existing searchPerfumes path", async () => {
    // Smoke-test that the wrapper doesn't accidentally narrow the
    // search surface — `searchPerfumes` matches all four columns and
    // the typeahead should too.
    await seedPerfume(env.db, {
      name: "Alpha",
      house: "Oriza",
      creator: null,
      notes: ["iris"],
    });
    await seedPerfume(env.db, {
      name: "Bravo",
      house: "Other",
      creator: "Ellena",
      notes: [],
    });
    await seedPerfume(env.db, {
      name: "Charlie",
      house: "Other",
      creator: null,
      notes: ["oakmoss"],
    });

    // House match.
    const byHouse = await env.curator.listCanonicalCandidatesAction(
      env.db.getDb(),
      sessionFor(CURATOR),
      { query: "oriza" },
    );
    expect(byHouse.candidates.map((c) => c.name)).toEqual(["Alpha"]);

    // Creator match.
    const byCreator = await env.curator.listCanonicalCandidatesAction(
      env.db.getDb(),
      sessionFor(CURATOR),
      { query: "ellena" },
    );
    expect(byCreator.candidates.map((c) => c.name)).toEqual(["Bravo"]);

    // Note match.
    const byNote = await env.curator.listCanonicalCandidatesAction(
      env.db.getDb(),
      sessionFor(CURATOR),
      { query: "oakmoss" },
    );
    expect(byNote.candidates.map((c) => c.name)).toEqual(["Charlie"]);
  });
});
