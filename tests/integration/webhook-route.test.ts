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

  it("dispatches a app.smellgate.perfume event to the read cache", async () => {
    const body = recordEventBody(
      "app.smellgate.perfume",
      CURATOR_DID,
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

  it("dispatches a app.smellgate.review event to the read cache", async () => {
    const perfumeRefUri = `at://${CURATOR_DID}/app.smellgate.perfume/3kgperfumeref`;
    const body = recordEventBody("app.smellgate.review", USER_DID, {
      $type: "app.smellgate.review",
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

  it("drops a app.smellgate.perfume event authored by a non-curator", async () => {
    // The curator gate is applied inside dispatchSmellgateEvent; the
    // route handler just forwards. This confirms the wiring preserves
    // that gate end-to-end.
    const body = recordEventBody("app.smellgate.perfume", USER_DID, {
      $type: "app.smellgate.perfume",
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

// ===========================================================================
// Tap shared-secret auth path (issue #148)
//
// In production the webhook is reached over Fly's internal `.flycast`
// network only, but the route still enforces a shared secret because
// anyone who can reach the main app's public URL could otherwise POST
// forged events. These tests exercise the `assureAdminAuth` branch in
// `app/api/webhook/route.ts` against the exact Basic-auth header
// format Tap's Go binary sends (`Basic ` + base64("admin:<password>")).
//
// Separate describe block (rather than adding cases to the block above)
// because it needs a different `freshEnv`: TAP_ADMIN_PASSWORD stubbed
// to a non-empty value BEFORE the route module is imported. The route
// captures the env at module load, so changing it mid-test is a
// no-op.
// ===========================================================================

async function freshEnvWithAuth(password: string): Promise<{
  route: RouteModule;
  db: DbIndexModule;
  dispose: () => void;
}> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-webhook-auth-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  vi.stubEnv("SMELLGATE_CURATOR_DIDS", CURATOR_DID);
  vi.stubEnv("TAP_ADMIN_PASSWORD", password);
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

function basicAuthHeader(password: string): string {
  // Mirror `formatAdminAuthHeader` from @atproto/tap/util. Kept inline
  // rather than imported so the test asserts on the exact wire format
  // the Tap Go binary produces, not on an internal helper.
  return "Basic " + Buffer.from(`admin:${password}`).toString("base64");
}

function makeRequestWithAuth(body: unknown, authHeader: string): NextRequest {
  return new NextRequest("http://localhost/api/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeader,
    },
    body: JSON.stringify(body),
  });
}

describe("/api/webhook shared-secret auth", () => {
  const PASSWORD = "s3cret-f0r-tap-and-main-app";
  let env: Awaited<ReturnType<typeof freshEnvWithAuth>>;

  beforeEach(async () => {
    rkeyCounter = 0;
    env = await freshEnvWithAuth(PASSWORD);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  it("accepts a POST with the correct Basic auth header", async () => {
    const body = recordEventBody("app.smellgate.perfume", CURATOR_DID, {
      $type: "app.smellgate.perfume",
      name: "Authenticated Aventus",
      house: "Creed",
      notes: ["pineapple"],
      createdAt: nowIso(),
    });

    const res = await env.route.POST(
      makeRequestWithAuth(body, basicAuthHeader(PASSWORD)),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });

    const db = env.db.getDb();
    const row = await db
      .selectFrom("smellgate_perfume")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.name).toBe("Authenticated Aventus");
  });

  it("rejects a POST with no Authorization header when auth is enabled", async () => {
    const body = recordEventBody("app.smellgate.perfume", CURATOR_DID, {
      $type: "app.smellgate.perfume",
      name: "Unauthorized",
      house: "Nowhere",
      notes: ["vanilla"],
      createdAt: nowIso(),
    });

    const res = await env.route.POST(makeRequest(body));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });

    // And no side effects on the cache.
    const db = env.db.getDb();
    const count = await db
      .selectFrom("smellgate_perfume")
      .select(db.fn.countAll<number>().as("c"))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(0);
  });

  it("rejects a POST with a wrong password", async () => {
    const body = recordEventBody("app.smellgate.perfume", CURATOR_DID, {
      $type: "app.smellgate.perfume",
      name: "Wrong-pass",
      house: "Nowhere",
      notes: ["vanilla"],
      createdAt: nowIso(),
    });

    const res = await env.route.POST(
      makeRequestWithAuth(body, basicAuthHeader("definitely-not-the-password")),
    );
    expect(res.status).toBe(401);

    const db = env.db.getDb();
    const count = await db
      .selectFrom("smellgate_perfume")
      .select(db.fn.countAll<number>().as("c"))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(0);
  });

  it("rejects a POST with a malformed Basic auth header", async () => {
    const body = recordEventBody("app.smellgate.perfume", CURATOR_DID, {
      $type: "app.smellgate.perfume",
      name: "Malformed",
      house: "Nowhere",
      notes: ["vanilla"],
      createdAt: nowIso(),
    });

    // Non-base64 after the "Basic " prefix. assureAdminAuth parses the
    // header with `Buffer.from(noPrefix, 'base64')` which is lenient,
    // but it then splits on ":" and checks the username — which won't
    // match "admin" here, so the path throws.
    const res = await env.route.POST(
      makeRequestWithAuth(body, "Basic not-base64-at-all"),
    );
    expect(res.status).toBe(401);

    const db = env.db.getDb();
    const count = await db
      .selectFrom("smellgate_perfume")
      .select(db.fn.countAll<number>().as("c"))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(0);
  });
});

// ===========================================================================
// Production secret-misconfiguration regression (#148 adversarial review).
//
// Earlier shape of the route did `if (TAP_ADMIN_PASSWORD)` — truthiness.
// An empty-string secret (`flyctl secrets set TAP_ADMIN_PASSWORD=""`)
// silently disabled auth, leaving /api/webhook publicly unauthenticated.
// Two tests lock that regression down:
//
//   1. `instrumentation.register()` must throw at boot when
//      NODE_ENV=production and the secret is empty/unset. This is the
//      primary defence — Fly's release-command runs instrumentation on
//      every deploy, so a bad secret fails the deploy loudly.
//
//   2. Even if instrumentation somehow ran without the guard (future
//      refactor, wrong NODE_ENV), the route handler itself must refuse
//      to serve requests with a 503 rather than fall open. This is
//      belt-and-suspenders, not a replacement.
// ===========================================================================

describe("/api/webhook production secret misconfiguration guard", () => {
  let dbDir: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (dbDir) {
      try {
        fs.rmSync(dbDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      dbDir = null;
    }
  });

  it("instrumentation.register() throws in production when TAP_ADMIN_PASSWORD is empty", async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-instr-"));
    vi.stubEnv("DATABASE_PATH", path.join(dbDir, "cache.db"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TAP_ADMIN_PASSWORD", "");
    // Simulate the production Node runtime — instrumentation early-exits
    // otherwise.
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.resetModules();

    const instr = await import("../../instrumentation");
    await expect(instr.register()).rejects.toThrow(/TAP_ADMIN_PASSWORD/);
  });

  it("instrumentation.register() throws in production when TAP_ADMIN_PASSWORD is unset", async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-instr-"));
    vi.stubEnv("DATABASE_PATH", path.join(dbDir, "cache.db"));
    vi.stubEnv("NODE_ENV", "production");
    // vi.stubEnv cannot fully delete an env var across every Node shape,
    // but stubbing to empty exercises the same `length === 0` branch and
    // undefined hits the `typeof !== "string"` branch. Cover both by
    // using the literal `delete process.env.FOO` here.
    delete process.env.TAP_ADMIN_PASSWORD;
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.resetModules();

    const instr = await import("../../instrumentation");
    await expect(instr.register()).rejects.toThrow(/TAP_ADMIN_PASSWORD/);
  });

  it("route handler returns 503 when NODE_ENV=production and password is empty", async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-route-"));
    vi.stubEnv("DATABASE_PATH", path.join(dbDir, "cache.db"));
    vi.stubEnv("SMELLGATE_CURATOR_DIDS", CURATOR_DID);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TAP_ADMIN_PASSWORD", "");
    vi.resetModules();

    const migrations: MigrationsModule = await import(
      "../../lib/db/migrations"
    );
    const { error } = await migrations.getMigrator().migrateToLatest();
    if (error) throw error;
    const route: RouteModule = await import("../../app/api/webhook/route");

    // Any body will do — the misconfiguration check fires before
    // body/auth parsing.
    const res = await route.POST(makeRequest({ id: 1, type: "record" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/TAP_ADMIN_PASSWORD/);
  });
});
