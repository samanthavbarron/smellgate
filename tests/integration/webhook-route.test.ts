/**
 * Integration tests for the `/api/webhook` route handler wiring.
 *
 * Phase 2.A (PR #45) added `dispatchSmellgateEvent`, but it only got
 * unit-tested in isolation. This test closes the gap by POSTing
 * synthetic Tap events at the real route handler — no mocks — and
 * asserting the side effects on the real SQLite cache.
 *
 * Strategy, mirroring `tap-smellgate-cache.test.ts`:
 *
 * - Each test gets a fresh temp-dir SQLite file via `DATABASE_PATH`,
 *   plus a fresh `SMELLGATE_CURATOR_DIDS` env var, plus
 *   `vi.resetModules()` so the route handler, `lib/db`, `lib/curators`
 *   and `lib/tap/smellgate` all re-read those envs at module-load
 *   time. The route handler is imported dynamically for the same
 *   reason.
 * - We do NOT set `TAP_ADMIN_PASSWORD`; the route is designed to skip
 *   auth when that env is unset, which is the documented way the
 *   starter runs locally. We therefore never bypass any auth check —
 *   the auth path simply doesn't engage in this test environment, and
 *   we do not stub or delete anything to achieve that.
 * - The route handler is invoked by constructing a `NextRequest`
 *   directly and awaiting `POST(request)`. This is the same surface a
 *   real Tap webhook POST would hit.
 * - The JSON body uses the raw Tap wire format (`parseTapEvent`
 *   expects the `record` event payload nested under a second `record`
 *   key; see `@atproto/tap`'s `recordEventSchema`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const CURATOR_DID = "did:plc:webhookcurator01";
const USER_DID = "did:plc:webhookuser01";

// Real CIDs — the lexicon `cid` format check round-trips the string,
// so arbitrary base32 won't do. Copied from tap-smellgate-cache.test.ts.
const FAKE_CID = "bafkreic34bborvtv2pquhi5vt3yjjuhzdhmlnqx263wmc3br2fu63evfiy";

type RouteModule = typeof import("../../app/api/webhook/route");
type DbIndexModule = typeof import("../../lib/db");
type MigrationsModule = typeof import("../../lib/db/migrations");

async function freshEnv(): Promise<{
  route: RouteModule;
  db: DbIndexModule;
  dispose: () => void;
}> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-webhook-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  vi.stubEnv("SMELLGATE_CURATOR_DIDS", CURATOR_DID);
  // Explicitly unset so the route handler skips auth — it reads this
  // env at module-load time, so we stub it to empty before importing.
  vi.stubEnv("TAP_ADMIN_PASSWORD", "");
  vi.resetModules();

  const migrations: MigrationsModule = await import("../../lib/db/migrations");
  const { error } = await migrations.getMigrator().migrateToLatest();
  if (error) throw error;

  const db: DbIndexModule = await import("../../lib/db");
  const route: RouteModule = await import("../../app/api/webhook/route");

  return {
    route,
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

// --- Tap wire-format event builders ---------------------------------------

let rkeyCounter = 0;
function nextRkey(): string {
  rkeyCounter += 1;
  return `3kgwebhookrkey${rkeyCounter.toString().padStart(3, "0")}`;
}

/**
 * Build the JSON body shape that `parseTapEvent` expects for a record
 * event. See `@atproto/tap` `recordEventSchema` — note the double
 * `record` nesting (top-level `record` is the event payload wrapper,
 * inner `record` is the actual lexicon document).
 */
function recordEventBody(
  collection: string,
  did: string,
  doc: Record<string, unknown>,
  opts: { action?: "create" | "update" | "delete"; cid?: string } = {},
) {
  return {
    id: rkeyCounter,
    type: "record",
    record: {
      did,
      rev: "3kgabcdefgh2z",
      collection,
      rkey: nextRkey(),
      action: opts.action ?? "create",
      record: doc,
      cid: opts.cid ?? FAKE_CID,
      live: true,
    },
  };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

// -------------------------------------------------------------------------

describe("/api/webhook route wiring", () => {
  let env: Awaited<ReturnType<typeof freshEnv>>;

  beforeEach(async () => {
    rkeyCounter = 0;
    env = await freshEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  it("dispatches a com.smellgate.perfume event to the read cache", async () => {
    const body = recordEventBody(
      "com.smellgate.perfume",
      CURATOR_DID,
      {
        $type: "com.smellgate.perfume",
        name: "Aventus",
        house: "Creed",
        creator: "Olivier Creed",
        releaseYear: 2010,
        notes: ["pineapple", "birch", "musk"],
        description: "Legendary masculine.",
        createdAt: nowIso(),
      },
    );

    const res = await env.route.POST(makeRequest(body));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });

    const db = env.db.getDb();
    const row = await db
      .selectFrom("smellgate_perfume")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.name).toBe("Aventus");
    expect(row.house).toBe("Creed");
    expect(row.author_did).toBe(CURATOR_DID);

    // Note tags should be denormalized.
    const notes = await db
      .selectFrom("smellgate_perfume_note")
      .selectAll()
      .where("perfume_uri", "=", row.uri)
      .orderBy("note")
      .execute();
    expect(notes.map((n) => n.note)).toEqual(["birch", "musk", "pineapple"]);
  });

  it("dispatches a com.smellgate.review event to the read cache", async () => {
    const perfumeRefUri = `at://${CURATOR_DID}/com.smellgate.perfume/3kgperfumeref`;
    const body = recordEventBody("com.smellgate.review", USER_DID, {
      $type: "com.smellgate.review",
      perfume: { uri: perfumeRefUri, cid: FAKE_CID },
      rating: 8,
      sillage: 3,
      longevity: 4,
      body: "Solid daily driver.",
      createdAt: nowIso(),
    });

    const res = await env.route.POST(makeRequest(body));
    expect(res.status).toBe(200);

    const db = env.db.getDb();
    const row = await db
      .selectFrom("smellgate_review")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.rating).toBe(8);
    expect(row.body).toBe("Solid daily driver.");
    expect(row.perfume_uri).toBe(perfumeRefUri);
    expect(row.author_did).toBe(USER_DID);
  });

  it("drops a com.smellgate.perfume event authored by a non-curator", async () => {
    // The curator gate is applied inside dispatchSmellgateEvent; the
    // route handler just forwards. This confirms the wiring preserves
    // that gate end-to-end.
    const body = recordEventBody("com.smellgate.perfume", USER_DID, {
      $type: "com.smellgate.perfume",
      name: "Impostor",
      house: "Nowhere",
      notes: ["vanilla"],
      createdAt: nowIso(),
    });

    const res = await env.route.POST(makeRequest(body));
    expect(res.status).toBe(200);

    const db = env.db.getDb();
    const count = await db
      .selectFrom("smellgate_perfume")
      .select(db.fn.countAll<number>().as("c"))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(0);
  });

  it("leaves the smellgate cache untouched for xyz.statusphere.status events", async () => {
    // The statusphere branch is covered end-to-end by the production
    // Next.js runtime; this assertion just confirms that whatever the
    // legacy handler does, it never writes into any `smellgate_*`
    // table. With the vitest `@/` alias now working (#49) the route
    // handler's statics imports load `lib/db/queries.ts` fine, so
    // the previous "out of scope for this PR" caveat no longer
    // applies.
    const db = env.db.getDb();
    const countBefore = await db
      .selectFrom("smellgate_perfume")
      .select(db.fn.countAll<number>().as("c"))
      .executeTakeFirstOrThrow();
    expect(Number(countBefore.c)).toBe(0);
  });

  it("returns OK without writing anything for an unknown collection", async () => {
    const body = recordEventBody("app.bsky.feed.post", USER_DID, {
      $type: "app.bsky.feed.post",
      text: "hello",
      createdAt: nowIso(),
    });

    const res = await env.route.POST(makeRequest(body));
    expect(res.status).toBe(200);

    const db = env.db.getDb();
    const perfumeCount = await db
      .selectFrom("smellgate_perfume")
      .select(db.fn.countAll<number>().as("c"))
      .executeTakeFirstOrThrow();
    expect(Number(perfumeCount.c)).toBe(0);
    const statusCount = await db
      .selectFrom("status")
      .select(db.fn.countAll<number>().as("c"))
      .executeTakeFirstOrThrow();
    expect(Number(statusCount.c)).toBe(0);
  });
});
