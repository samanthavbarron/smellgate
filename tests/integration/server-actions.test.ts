/**
 * Integration tests for the OAuth-gated server actions in
 * `lib/server/smellgate-actions.ts` (Phase 3.B / issue #54).
 *
 * Each action gets:
 *   - a happy-path test that signs in via the real OAuth flow against
 *     an in-process PDS, calls the action with a session, and verifies
 *     that the new record actually lives on the user's PDS,
 *   - at least one negative test that exercises a validation rule.
 *
 * Why no mocks: per AGENTS.md, integration tests must hit a real PDS
 * via real OAuth. We reuse `tests/helpers/pds.ts` for the PDS lifecycle
 * and `createTestOAuthClient` for the production-shaped OAuth client,
 * and we drive the authorization-code flow with the same `node:http`
 * cookie-jar dance that `tests/integration/oauth-pds.test.ts` uses.
 *
 * Why we pre-populate the cache by calling `dispatchSmellgateEvent`
 * directly with synthetic events: every action validates its strongRef
 * target against the cache before writing. The Tap webhook is the
 * production path, but Phase 2.A's tests have already established that
 * synthetic-event dispatch is a valid setup move. We use it here to
 * give the actions a known perfume / description / review to reference.
 *
 * Each test gets a fresh SQLite cache file via `freshCacheEnv()` and a
 * shared in-process PDS for the whole `describe` block (PDS startup is
 * the slow bit; sharing it across all 10+ cases keeps the suite under a
 * minute on a laptop).
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { NodeOAuthClient, OAuthSession } from "@atproto/oauth-client-node";
import type { RecordEvent } from "@atproto/tap";
import {
  type EphemeralPds,
  createTestAccounts,
  createTestOAuthClient,
  startEphemeralPds,
  stopEphemeralPds,
  type TestAccountCreds,
} from "../helpers/pds";

// Real CIDs (sha256 raw) — opaque strings that pass the lexicon's `cid`
// format check. Same constants `tests/integration/tap-smellgate-cache.test.ts`
// uses, on purpose: they're known to round-trip through `$safeParse`.
const FAKE_CID = "bafkreic34bborvtv2pquhi5vt3yjjuhzdhmlnqx263wmc3br2fu63evfiy";

// A throwaway curator DID. We stub `SMELLGATE_CURATOR_DIDS` to this so
// the dispatcher will accept synthetic curator-authored perfume records.
const FAKE_CURATOR_DID = "did:plc:server-actions-curator";

// -----------------------------------------------------------------------------
// Per-test cache environment. Mirrors the freshEnv pattern in
// tap-smellgate-cache.test.ts: stub env vars, reset modules, dynamically
// import the modules that read them at load time.
// -----------------------------------------------------------------------------

type ActionsModule = typeof import("../../lib/server/smellgate-actions");
type TapModule = typeof import("../../lib/tap/smellgate");
type DbIndexModule = typeof import("../../lib/db");
type MigrationsModule = typeof import("../../lib/db/migrations");

interface CacheEnv {
  actions: ActionsModule;
  tap: TapModule;
  db: DbIndexModule;
  dispose: () => void;
}

async function freshCacheEnv(): Promise<CacheEnv> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-actions-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  vi.stubEnv("SMELLGATE_CURATOR_DIDS", FAKE_CURATOR_DID);
  vi.resetModules();

  const migrations: MigrationsModule = await import("../../lib/db/migrations");
  const { error } = await migrations.getMigrator().migrateToLatest();
  if (error) throw error;

  const db: DbIndexModule = await import("../../lib/db");
  const tap: TapModule = await import("../../lib/tap/smellgate");
  const actions: ActionsModule = await import(
    "../../lib/server/smellgate-actions"
  );

  return {
    actions,
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

// -----------------------------------------------------------------------------
// Synthetic event builders for the cache pre-population step.
// -----------------------------------------------------------------------------

let rkeyCounter = 0;
function nextRkey(): string {
  rkeyCounter += 1;
  return `3jzfsa00${rkeyCounter.toString().padStart(4, "0")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEvent(
  collection: string,
  did: string,
  record: Record<string, unknown>,
): RecordEvent {
  return {
    id: rkeyCounter,
    type: "record",
    action: "create",
    did,
    rev: "3kgaaaaaaaaa2",
    collection,
    rkey: nextRkey(),
    record,
    cid: FAKE_CID,
    live: true,
  };
}

/**
 * Insert a synthetic curator-authored perfume into the cache and
 * return its AT-URI. The dispatcher writes the row using `evt.cid`
 * (= `FAKE_CID`), which means a server action that resolves the URI
 * back out of the cache will see that same CID — exactly the
 * round-trip we want.
 */
async function seedPerfume(
  env: CacheEnv,
  name: string = "Test Perfume",
): Promise<string> {
  const evt = makeEvent("com.smellgate.perfume", FAKE_CURATOR_DID, {
    $type: "com.smellgate.perfume",
    name,
    house: "Test House",
    notes: ["test-note"],
    createdAt: nowIso(),
  });
  await env.tap.dispatchSmellgateEvent(env.db.getDb(), evt);
  return `at://${FAKE_CURATOR_DID}/${evt.collection}/${evt.rkey}`;
}

/**
 * Seed a synthetic description record authored by an arbitrary user
 * DID. The vote action only validates that the description URI exists
 * in the cache; it doesn't care who wrote it.
 */
async function seedDescription(
  env: CacheEnv,
  authorDid: string,
  perfumeUri: string,
): Promise<string> {
  const evt = makeEvent("com.smellgate.description", authorDid, {
    $type: "com.smellgate.description",
    perfume: { uri: perfumeUri, cid: FAKE_CID },
    body: "A community description for testing.",
    createdAt: nowIso(),
  });
  await env.tap.dispatchSmellgateEvent(env.db.getDb(), evt);
  return `at://${authorDid}/${evt.collection}/${evt.rkey}`;
}

async function seedReview(
  env: CacheEnv,
  authorDid: string,
  perfumeUri: string,
): Promise<string> {
  const evt = makeEvent("com.smellgate.review", authorDid, {
    $type: "com.smellgate.review",
    perfume: { uri: perfumeUri, cid: FAKE_CID },
    rating: 8,
    sillage: 4,
    longevity: 4,
    body: "A review for testing.",
    createdAt: nowIso(),
  });
  await env.tap.dispatchSmellgateEvent(env.db.getDb(), evt);
  return `at://${authorDid}/${evt.collection}/${evt.rkey}`;
}

// -----------------------------------------------------------------------------
// Real OAuth flow against the in-process PDS. Same shape as
// `tests/integration/oauth-pds.test.ts#completeOAuthFlow` — kept inline
// (rather than extracted into a helper module) so each test file reads
// top-to-bottom and the moving parts are visible.
// -----------------------------------------------------------------------------

class CookieJar {
  private cookies = new Map<string, string>();
  ingest(setCookieHeader: string[] | null | undefined) {
    if (!setCookieHeader) return;
    for (const raw of setCookieHeader) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

function getSetCookies(headers: http.IncomingHttpHeaders): string[] {
  const raw = headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

async function completeOAuthFlow(
  client: NodeOAuthClient,
  handle: string,
  password: string,
): Promise<OAuthSession> {
  const authorizeUrl = await client.authorize(handle, {
    scope: "atproto transition:generic",
  });
  const origin = new URL(authorizeUrl).origin;
  const jar = new CookieJar();

  const pageRes = await rawRequest(authorizeUrl.toString(), {
    method: "GET",
    headers: {
      accept: "text/html",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-site": "none",
      "user-agent": "smellgate-actions-test",
    },
  });
  jar.ingest(getSetCookies(pageRes.headers));
  if (pageRes.status !== 200) {
    throw new Error(
      `Unexpected authorize page status ${pageRes.status}: ${pageRes.body}`,
    );
  }
  const csrf = jar.get("csrf-token");
  if (!csrf) throw new Error("PDS did not set csrf-token cookie");

  const apiHeaders = (): Record<string, string> => ({
    accept: "application/json",
    "content-type": "application/json",
    cookie: jar.header(),
    "x-csrf-token": csrf,
    origin,
    referer: authorizeUrl.toString(),
    "sec-fetch-mode": "same-origin",
    "sec-fetch-site": "same-origin",
    "sec-fetch-dest": "empty",
    "user-agent": "smellgate-actions-test",
  });

  const apiUrl = (endpoint: string) =>
    `${origin}/@atproto/oauth-provider/~api${endpoint}`;

  const signInRes = await rawRequest(apiUrl("/sign-in"), {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({
      locale: "en",
      username: handle,
      password,
      remember: true,
    }),
  });
  jar.ingest(getSetCookies(signInRes.headers));
  if (signInRes.status >= 400) {
    throw new Error(`sign-in failed (${signInRes.status}): ${signInRes.body}`);
  }
  const signInBody = JSON.parse(signInRes.body) as {
    account: { sub: string };
  };

  const consentRes = await rawRequest(apiUrl("/consent"), {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ sub: signInBody.account.sub }),
  });
  jar.ingest(getSetCookies(consentRes.headers));
  if (consentRes.status >= 400) {
    throw new Error(`consent failed (${consentRes.status}): ${consentRes.body}`);
  }
  const { url: consentRedirectUrl } = JSON.parse(consentRes.body) as {
    url: string;
  };

  const redirectRes = await rawRequest(consentRedirectUrl, {
    method: "GET",
    headers: {
      cookie: jar.header(),
      accept: "text/html",
      origin,
      referer: authorizeUrl.toString(),
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-site": "same-origin",
      "user-agent": "smellgate-actions-test",
    },
  });
  const location = redirectRes.headers["location"];
  if (!location || Array.isArray(location)) {
    throw new Error(
      `redirect step returned ${redirectRes.status} with no usable Location: ${redirectRes.body}`,
    );
  }
  const callbackUrl = new URL(location);
  if (!callbackUrl.searchParams.get("code")) {
    throw new Error(`redirect Location missing code: ${location}`);
  }
  const { session } = await client.callback(callbackUrl.searchParams);
  return session;
}

// -----------------------------------------------------------------------------
// Helpers for asserting against the user's PDS after the action runs.
// -----------------------------------------------------------------------------

/** Read a record back from the user's PDS via the OAuth-bound fetch. */
async function getRecord(
  session: OAuthSession,
  uri: string,
): Promise<{ value: Record<string, unknown> }> {
  // at://did/collection/rkey
  const rest = uri.replace(/^at:\/\//, "");
  const [did, collection, rkey] = rest.split("/");
  const url =
    `/xrpc/com.atproto.repo.getRecord` +
    `?repo=${encodeURIComponent(did)}` +
    `&collection=${encodeURIComponent(collection)}` +
    `&rkey=${encodeURIComponent(rkey)}`;
  const res = await session.fetchHandler(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`getRecord ${uri} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as { value: Record<string, unknown> };
}

async function listRecordCount(
  session: OAuthSession,
  did: string,
  collection: string,
): Promise<number> {
  const url =
    `/xrpc/com.atproto.repo.listRecords` +
    `?repo=${encodeURIComponent(did)}` +
    `&collection=${encodeURIComponent(collection)}` +
    `&limit=100`;
  const res = await session.fetchHandler(url, { method: "GET" });
  if (!res.ok) {
    // listRecords returns 200 + empty array for unknown collections,
    // so a non-2xx is a real error.
    throw new Error(`listRecords ${collection} failed (${res.status})`);
  }
  const body = (await res.json()) as { records: unknown[] };
  return body.records.length;
}

// -----------------------------------------------------------------------------
// Test suite
// -----------------------------------------------------------------------------

describe("smellgate server actions (Phase 3.B)", () => {
  let pds: EphemeralPds;
  let accounts: TestAccountCreds[];
  let alice: TestAccountCreds;
  let aliceClient: NodeOAuthClient;
  let aliceSession: OAuthSession;

  beforeAll(async () => {
    pds = await startEphemeralPds();
    accounts = await createTestAccounts(pds);
    const found = accounts.find((a) => a.shortName === "alice");
    if (!found) throw new Error("alice not seeded");
    alice = found;
    aliceClient = createTestOAuthClient(pds);
    aliceSession = await completeOAuthFlow(aliceClient, alice.handle, alice.password);
    expect(aliceSession.did).toBe(alice.did);
  }, 120_000);

  afterAll(async () => {
    if (pds) await stopEphemeralPds(pds);
  });

  let env: CacheEnv;

  beforeEach(async () => {
    rkeyCounter = 0;
    env = await freshCacheEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  // -- addToShelfAction -----------------------------------------------------

  describe("addToShelfAction", () => {
    it("writes a shelfItem to the user's PDS for a known perfume", async () => {
      const perfumeUri = await seedPerfume(env, "Aventus");
      const result = await env.actions.addToShelfAction(
        env.db.getDb(),
        aliceSession,
        {
          perfumeUri,
          bottleSizeMl: 100,
          isDecant: false,
        },
      );
      expect(result.uri).toMatch(
        new RegExp(`^at://${alice.did}/com\\.smellgate\\.shelfItem/`),
      );
      // Issue #119: response echoes the persisted record, including
      // the optional bottleSizeMl + isDecant flags. `indexed: false`
      // is always present so CLIs can poll.
      expect(result.indexed).toBe(false);
      expect(result.record.perfumeUri).toBe(perfumeUri);
      expect(result.record.bottleSizeMl).toBe(100);
      expect(result.record.isDecant).toBe(false);
      expect(typeof result.record.createdAt).toBe("string");
      const fetched = await getRecord(aliceSession, result.uri);
      const value = fetched.value as {
        $type: string;
        perfume: { uri: string; cid: string };
        bottleSizeMl?: number;
      };
      expect(value.$type).toBe("com.smellgate.shelfItem");
      expect(value.perfume.uri).toBe(perfumeUri);
      expect(value.perfume.cid).toBe(FAKE_CID);
      expect(value.bottleSizeMl).toBe(100);
    }, 60_000);

    // Issue #119: server-side bounds on bottleSizeMl. Negative values
    // were already caught by the `<= 0` guard; the new upper bound
    // is 1000ml (MAX_BOTTLE_SIZE_ML in the action module).
    it("rejects an absurdly large bottleSizeMl with 400 and writes nothing", async () => {
      const perfumeUri = await seedPerfume(env, "Huge Bottle");
      const beforeCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.shelfItem",
      );
      await expect(
        env.actions.addToShelfAction(env.db.getDb(), aliceSession, {
          perfumeUri,
          bottleSizeMl: 999999,
        }),
      ).rejects.toMatchObject({ name: "ActionError", status: 400 });
      const afterCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.shelfItem",
      );
      expect(afterCount).toBe(beforeCount);
    }, 30_000);

    it("rejects a negative bottleSizeMl with 400 and writes nothing", async () => {
      const perfumeUri = await seedPerfume(env, "Negative Bottle");
      const beforeCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.shelfItem",
      );
      await expect(
        env.actions.addToShelfAction(env.db.getDb(), aliceSession, {
          perfumeUri,
          bottleSizeMl: -5,
        }),
      ).rejects.toMatchObject({ name: "ActionError", status: 400 });
      const afterCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.shelfItem",
      );
      expect(afterCount).toBe(beforeCount);
    }, 30_000);

    it("omits optional echo fields when they were not provided", async () => {
      const perfumeUri = await seedPerfume(env, "Minimal Shelf");
      const result = await env.actions.addToShelfAction(
        env.db.getDb(),
        aliceSession,
        { perfumeUri },
      );
      expect(result.record.perfumeUri).toBe(perfumeUri);
      expect(result.record.bottleSizeMl).toBeUndefined();
      expect(result.record.isDecant).toBeUndefined();
      expect(result.record.acquiredAt).toBeUndefined();
    }, 60_000);

    it("rejects unknown perfumeUri with 404 and writes nothing", async () => {
      const beforeCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.shelfItem",
      );
      await expect(
        env.actions.addToShelfAction(env.db.getDb(), aliceSession, {
          perfumeUri: "at://did:plc:not-real/com.smellgate.perfume/abc",
        }),
      ).rejects.toMatchObject({
        name: "ActionError",
        status: 404,
      });
      const afterCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.shelfItem",
      );
      expect(afterCount).toBe(beforeCount);
    }, 30_000);
  });

  // -- postReviewAction -----------------------------------------------------

  describe("postReviewAction", () => {
    it("writes a review to the user's PDS for a known perfume", async () => {
      const perfumeUri = await seedPerfume(env, "Sauvage");
      const result = await env.actions.postReviewAction(
        env.db.getDb(),
        aliceSession,
        {
          perfumeUri,
          rating: 9,
          sillage: 4,
          longevity: 5,
          body: "Surprisingly good for what it is.",
        },
      );
      expect(result.uri).toMatch(
        new RegExp(`^at://${alice.did}/com\\.smellgate\\.review/`),
      );
      // Issue #124: response echoes the persisted record.
      expect(result.indexed).toBe(false);
      expect(result.record.perfumeUri).toBe(perfumeUri);
      expect(result.record.rating).toBe(9);
      expect(result.record.sillage).toBe(4);
      expect(result.record.longevity).toBe(5);
      expect(result.record.body).toContain("Surprisingly");
      expect(typeof result.record.createdAt).toBe("string");
      const fetched = await getRecord(aliceSession, result.uri);
      const value = fetched.value as {
        $type: string;
        perfume: { uri: string };
        rating: number;
        body: string;
      };
      expect(value.$type).toBe("com.smellgate.review");
      expect(value.perfume.uri).toBe(perfumeUri);
      expect(value.rating).toBe(9);
      expect(value.body).toContain("Surprisingly");
    }, 60_000);

    it("rejects out-of-range rating with 400 and writes nothing", async () => {
      const perfumeUri = await seedPerfume(env, "Out Of Range");
      const beforeCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.review",
      );
      await expect(
        env.actions.postReviewAction(env.db.getDb(), aliceSession, {
          perfumeUri,
          rating: 11,
          sillage: 3,
          longevity: 3,
          body: "should fail",
        }),
      ).rejects.toMatchObject({ name: "ActionError", status: 400 });
      const afterCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.review",
      );
      expect(afterCount).toBe(beforeCount);
    }, 30_000);
  });

  // -- postDescriptionAction ------------------------------------------------

  describe("postDescriptionAction", () => {
    it("writes a description to the user's PDS for a known perfume", async () => {
      const perfumeUri = await seedPerfume(env, "Bleu");
      const result = await env.actions.postDescriptionAction(
        env.db.getDb(),
        aliceSession,
        {
          perfumeUri,
          body: "Crisp aromatic with a clean drydown.",
        },
      );
      expect(result.uri).toMatch(
        new RegExp(`^at://${alice.did}/com\\.smellgate\\.description/`),
      );
      // Issue #124: response echoes the persisted record.
      expect(result.indexed).toBe(false);
      expect(result.record.perfumeUri).toBe(perfumeUri);
      expect(result.record.body).toContain("aromatic");
      expect(typeof result.record.createdAt).toBe("string");
      const fetched = await getRecord(aliceSession, result.uri);
      const value = fetched.value as { $type: string; body: string };
      expect(value.$type).toBe("com.smellgate.description");
      expect(value.body).toContain("aromatic");
    }, 60_000);

    it("rejects empty body with 400 and writes nothing", async () => {
      const perfumeUri = await seedPerfume(env, "Empty Body");
      const beforeCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.description",
      );
      await expect(
        env.actions.postDescriptionAction(env.db.getDb(), aliceSession, {
          perfumeUri,
          body: "   ",
        }),
      ).rejects.toMatchObject({ name: "ActionError", status: 400 });
      const afterCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.description",
      );
      expect(afterCount).toBe(beforeCount);
    }, 30_000);
  });

  // -- voteOnDescriptionAction ----------------------------------------------

  describe("voteOnDescriptionAction", () => {
    // Descriptions authored by another DID — the self-vote guard
    // (issue #135) rejects votes when `session.did === authorDid`, so
    // the happy-path tests must use someone else's description.
    const OTHER_AUTHOR_DID = "did:plc:other-description-author";

    it("writes a vote to the user's PDS for a known description", async () => {
      const perfumeUri = await seedPerfume(env, "Vote Target");
      const descriptionUri = await seedDescription(env, OTHER_AUTHOR_DID, perfumeUri);
      const result = await env.actions.voteOnDescriptionAction(
        env.db.getDb(),
        aliceSession,
        { descriptionUri, direction: "up" },
      );
      expect(result.uri).toMatch(
        new RegExp(`^at://${alice.did}/com\\.smellgate\\.vote/`),
      );
      // Issue #124: response echoes the persisted record.
      expect(result.indexed).toBe(false);
      expect(result.record.descriptionUri).toBe(descriptionUri);
      expect(result.record.direction).toBe("up");
      expect(typeof result.record.createdAt).toBe("string");
      const fetched = await getRecord(aliceSession, result.uri);
      const value = fetched.value as {
        $type: string;
        direction: string;
        subject: { uri: string };
      };
      expect(value.$type).toBe("com.smellgate.vote");
      expect(value.direction).toBe("up");
      expect(value.subject.uri).toBe(descriptionUri);
    }, 60_000);

    it("rejects an invalid direction with 400 and writes nothing", async () => {
      const perfumeUri = await seedPerfume(env, "Direction Target");
      const descriptionUri = await seedDescription(env, OTHER_AUTHOR_DID, perfumeUri);
      const beforeCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.vote",
      );
      await expect(
        env.actions.voteOnDescriptionAction(env.db.getDb(), aliceSession, {
          descriptionUri,
          // @ts-expect-error — exercising the runtime guard
          direction: "sideways",
        }),
      ).rejects.toMatchObject({ name: "ActionError", status: 400 });
      const afterCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.vote",
      );
      expect(afterCount).toBe(beforeCount);
    }, 30_000);

    it("rejects an unknown descriptionUri with 404", async () => {
      await expect(
        env.actions.voteOnDescriptionAction(env.db.getDb(), aliceSession, {
          descriptionUri:
            "at://did:plc:not-real/com.smellgate.description/missing",
          direction: "up",
        }),
      ).rejects.toMatchObject({ name: "ActionError", status: 404 });
    }, 30_000);
  });

  // -- commentOnReviewAction ------------------------------------------------

  describe("commentOnReviewAction", () => {
    it("writes a comment to the user's PDS for a known review", async () => {
      const perfumeUri = await seedPerfume(env, "Comment Target");
      const reviewUri = await seedReview(env, alice.did, perfumeUri);
      const result = await env.actions.commentOnReviewAction(
        env.db.getDb(),
        aliceSession,
        { reviewUri, body: "Agree completely." },
      );
      expect(result.uri).toMatch(
        new RegExp(`^at://${alice.did}/com\\.smellgate\\.comment/`),
      );
      // Issue #124: response echoes the persisted record.
      expect(result.indexed).toBe(false);
      expect(result.record.reviewUri).toBe(reviewUri);
      expect(result.record.body).toBe("Agree completely.");
      expect(typeof result.record.createdAt).toBe("string");
      const fetched = await getRecord(aliceSession, result.uri);
      const value = fetched.value as {
        $type: string;
        body: string;
        subject: { uri: string };
      };
      expect(value.$type).toBe("com.smellgate.comment");
      expect(value.body).toBe("Agree completely.");
      expect(value.subject.uri).toBe(reviewUri);
    }, 60_000);

    it("rejects an unknown reviewUri with 404 and writes nothing", async () => {
      const beforeCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.comment",
      );
      await expect(
        env.actions.commentOnReviewAction(env.db.getDb(), aliceSession, {
          reviewUri: "at://did:plc:not-real/com.smellgate.review/missing",
          body: "Should fail.",
        }),
      ).rejects.toMatchObject({ name: "ActionError", status: 404 });
      const afterCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.comment",
      );
      expect(afterCount).toBe(beforeCount);
    }, 30_000);
  });

  // -- writeGuards: HTML sanitization at the write edge (#129 / #130) -------
  //
  // For each free-text field surface, write through the real action,
  // read the resulting record back off the user's PDS, and assert the
  // stored body has NO script tag and NO event-handler attribute.
  // Going through the real PDS (not just unit-testing the sanitizer)
  // is the signal AGENTS.md asks for: "A green unit suite with mocked
  // ATProto calls is not a passing signal."

  const XSS_PAYLOAD =
    'Smells like <script>alert("xss")</script> pine needles and rain <img src=x onerror=alert(1)>.';

  describe("writeGuards: HTML sanitization at the write edge", () => {
    it("strips HTML from review body before writing to the PDS", async () => {
      const perfumeUri = await seedPerfume(env, "XSS Review");
      const result = await env.actions.postReviewAction(
        env.db.getDb(),
        aliceSession,
        {
          perfumeUri,
          rating: 7,
          sillage: 3,
          longevity: 3,
          body: XSS_PAYLOAD,
        },
      );
      const fetched = await getRecord(aliceSession, result.uri);
      const body = (fetched.value as { body: string }).body;
      expect(body).not.toContain("<script");
      expect(body).not.toContain("onerror");
      expect(body).not.toContain("<img");
      expect(body).not.toContain("alert(");
      expect(body).toContain("pine needles");
    }, 60_000);

    it("strips HTML from description body before writing to the PDS", async () => {
      const perfumeUri = await seedPerfume(env, "XSS Description");
      const result = await env.actions.postDescriptionAction(
        env.db.getDb(),
        aliceSession,
        {
          perfumeUri,
          body: XSS_PAYLOAD,
        },
      );
      const fetched = await getRecord(aliceSession, result.uri);
      const body = (fetched.value as { body: string }).body;
      expect(body).not.toContain("<script");
      expect(body).not.toContain("onerror");
      expect(body).not.toContain("<img");
      expect(body).not.toContain("alert(");
    }, 60_000);

    it("strips HTML from comment body before writing to the PDS", async () => {
      const perfumeUri = await seedPerfume(env, "XSS Comment");
      const reviewUri = await seedReview(env, alice.did, perfumeUri);
      const result = await env.actions.commentOnReviewAction(
        env.db.getDb(),
        aliceSession,
        { reviewUri, body: XSS_PAYLOAD },
      );
      const fetched = await getRecord(aliceSession, result.uri);
      const body = (fetched.value as { body: string }).body;
      expect(body).not.toContain("<script");
      expect(body).not.toContain("onerror");
      expect(body).not.toContain("<img");
      expect(body).not.toContain("alert(");
    }, 60_000);

    it("rejects a body that is entirely HTML with 400 and writes nothing", async () => {
      const perfumeUri = await seedPerfume(env, "All HTML");
      const beforeCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.description",
      );
      await expect(
        env.actions.postDescriptionAction(env.db.getDb(), aliceSession, {
          perfumeUri,
          body: "<script>alert(1)</script>",
        }),
      ).rejects.toMatchObject({ name: "ActionError", status: 400 });
      const afterCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.description",
      );
      expect(afterCount).toBe(beforeCount);
    }, 30_000);
  });

  // -- writeGuards: note normalization + echo (#128) -----------------------

  describe("writeGuards: submitPerfumeAction note normalization", () => {
    it("normalizes notes on submission and echoes the normalized array", async () => {
      const result = await env.actions.submitPerfumeAction(
        env.db.getDb(),
        aliceSession,
        {
          name: "Unicode Tester",
          house: "Test Maison",
          // The exact repro from issue #128.
          notes: ["🌸 rose", "RoSe", "   rose   ", "rose\n", "rose 🫶", "oud"],
        },
      );
      // The response echoes the normalized notes (issue #128 explicit
      // requirement).
      expect(result.normalized.notes).toEqual(["rose", "oud"]);

      // And the record on the PDS carries the same normalized notes.
      const fetched = await getRecord(aliceSession, result.uri);
      const value = fetched.value as { notes: string[] };
      expect(value.notes).toEqual(["rose", "oud"]);
    }, 60_000);

    it("rejects a submission with a whitespace-only note with 400", async () => {
      await expect(
        env.actions.submitPerfumeAction(env.db.getDb(), aliceSession, {
          name: "Bad Notes",
          house: "House",
          notes: ["rose", "   "],
        }),
      ).rejects.toMatchObject({ name: "ActionError", status: 400 });
    }, 30_000);

    it("strips HTML from submission description at the write edge (#129)", async () => {
      const result = await env.actions.submitPerfumeAction(
        env.db.getDb(),
        aliceSession,
        {
          name: "XSS Test",
          house: "Test House",
          notes: ["test"],
          description: XSS_PAYLOAD,
          rationale:
            'Please add <script>alert("xss")</script> this perfume.',
        },
      );
      expect(result.normalized.description).toBeDefined();
      expect(result.normalized.description).not.toContain("<script");
      expect(result.normalized.description).not.toContain("onerror");
      expect(result.normalized.rationale).toBeDefined();
      expect(result.normalized.rationale).not.toContain("<script");

      const fetched = await getRecord(aliceSession, result.uri);
      const value = fetched.value as {
        description?: string;
        rationale?: string;
      };
      expect(value.description).toBeDefined();
      expect(value.description).not.toContain("<script");
      expect(value.description).not.toContain("onerror");
      expect(value.rationale).toBeDefined();
      expect(value.rationale).not.toContain("<script");
    }, 60_000);
  });

  // -- writeGuards: self-vote + duplicate-vote guards (#135) ---------------

  describe("writeGuards: vote guards", () => {
    it("rejects a self-vote with 400 and writes nothing", async () => {
      const perfumeUri = await seedPerfume(env, "Self Vote");
      // Alice's own description.
      const descriptionUri = await seedDescription(env, alice.did, perfumeUri);
      const beforeCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.vote",
      );
      await expect(
        env.actions.voteOnDescriptionAction(env.db.getDb(), aliceSession, {
          descriptionUri,
          direction: "up",
        }),
      ).rejects.toMatchObject({
        name: "ActionError",
        status: 400,
      });
      const afterCount = await listRecordCount(
        aliceSession,
        alice.did,
        "com.smellgate.vote",
      );
      expect(afterCount).toBe(beforeCount);
    }, 60_000);

    it("replaces a prior vote by the same author on the same subject", async () => {
      const perfumeUri = await seedPerfume(env, "Dup Vote");
      const otherAuthor = "did:plc:another-description-author";
      const descriptionUri = await seedDescription(env, otherAuthor, perfumeUri);

      // First vote: up.
      const first = await env.actions.voteOnDescriptionAction(
        env.db.getDb(),
        aliceSession,
        { descriptionUri, direction: "up" },
      );
      expect(first.uri).toMatch(/^at:\/\//);

      // Second vote: down. The duplicate-vote guard should delete
      // the prior `up` vote before creating the new one. After the
      // second call, alice's vote collection should contain exactly
      // one record for this subject.
      const second = await env.actions.voteOnDescriptionAction(
        env.db.getDb(),
        aliceSession,
        { descriptionUri, direction: "down" },
      );
      expect(second.uri).toMatch(/^at:\/\//);
      expect(second.uri).not.toBe(first.uri);

      // List alice's votes, count how many still point at descriptionUri.
      const listUrl =
        `/xrpc/com.atproto.repo.listRecords` +
        `?repo=${encodeURIComponent(alice.did)}` +
        `&collection=com.smellgate.vote` +
        `&limit=100`;
      const listRes = await aliceSession.fetchHandler(listUrl, {
        method: "GET",
      });
      const listBody = (await listRes.json()) as {
        records: {
          uri: string;
          value: { subject?: { uri?: string }; direction?: string };
        }[];
      };
      const matching = listBody.records.filter(
        (r) => r.value?.subject?.uri === descriptionUri,
      );
      expect(matching).toHaveLength(1);
      expect(matching[0].value.direction).toBe("down");
    }, 90_000);
  });

  // -- response-shape sweep: submit envelope (#111) + idempotence (#126) ----

  describe("submitPerfumeAction response envelope", () => {
    it("returns the pending_review envelope with status + message + record", async () => {
      const result = await env.actions.submitPerfumeAction(
        env.db.getDb(),
        aliceSession,
        {
          name: "Envelope Test",
          house: "Envelope House",
          notes: ["rose", "oud"],
          creator: "Some Perfumer",
          releaseYear: 2024,
          description: "A test description.",
        },
      );
      expect(result.status).toBe("pending_review");
      expect(result.message).toMatch(/curator/i);
      expect(result.indexed).toBe(false);
      expect(result.record.name).toBe("Envelope Test");
      expect(result.record.house).toBe("Envelope House");
      expect(result.record.creator).toBe("Some Perfumer");
      expect(result.record.releaseYear).toBe(2024);
      expect(result.record.notes).toEqual(["rose", "oud"]);
      expect(result.record.description).toBe("A test description.");
      expect(typeof result.record.createdAt).toBe("string");
      // The `normalized` alias is still present for #128 callers.
      expect(result.normalized.notes).toEqual(["rose", "oud"]);
    }, 60_000);

    it("returns the existing URI idempotently on a same-(name, house) resubmit", async () => {
      const first = await env.actions.submitPerfumeAction(
        env.db.getDb(),
        aliceSession,
        {
          name: "Idempotent Test",
          house: "Same House",
          notes: ["vanilla"],
        },
      );
      // Second submit with the same name+house (but different other
      // fields!) should return the first submission's URI, with
      // `idempotent: true`.
      const second = await env.actions.submitPerfumeAction(
        env.db.getDb(),
        aliceSession,
        {
          name: "Idempotent Test",
          house: "Same House",
          notes: ["vanilla", "tonka"], // different notes — still dup
          rationale: "Second attempt with extra rationale",
        },
      );
      expect(second.uri).toBe(first.uri);
      expect(second.idempotent).toBe(true);
      expect(second.status).toBe("pending_review");

      // Only one submission on alice's PDS for this name.
      const listRes = await aliceSession.fetchHandler(
        `/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(
          alice.did,
        )}&collection=com.smellgate.perfumeSubmission&limit=100`,
        { method: "GET" },
      );
      const listBody = (await listRes.json()) as {
        records: { uri: string; value: { name?: string; house?: string } }[];
      };
      const matching = listBody.records.filter(
        (r) =>
          r.value?.name === "Idempotent Test" &&
          r.value?.house === "Same House",
      );
      expect(matching).toHaveLength(1);
    }, 90_000);

    it("matches case-insensitively when checking for duplicate submissions", async () => {
      const first = await env.actions.submitPerfumeAction(
        env.db.getDb(),
        aliceSession,
        {
          name: "Case Test",
          house: "Case House",
          notes: ["bergamot"],
        },
      );
      const second = await env.actions.submitPerfumeAction(
        env.db.getDb(),
        aliceSession,
        {
          name: "  case test  ", // whitespace + lowercase
          house: "CASE HOUSE",
          notes: ["bergamot"],
        },
      );
      expect(second.uri).toBe(first.uri);
      expect(second.idempotent).toBe(true);
    }, 90_000);
  });

  // -- response-shape sweep: listMySubmissionsAction (#131) ----------------

  describe("listMySubmissionsAction", () => {
    it("returns the user's submissions annotated with resolution state", async () => {
      // Seed three submissions by alice directly via the real action,
      // then dispatch a synthetic resolution event for the first one
      // (approved) and another for the second (rejected). Third stays
      // pending.
      const subA = await env.actions.submitPerfumeAction(
        env.db.getDb(),
        aliceSession,
        {
          name: "Alpha Submission",
          house: "Alpha House",
          notes: ["a"],
        },
      );
      const subB = await env.actions.submitPerfumeAction(
        env.db.getDb(),
        aliceSession,
        {
          name: "Bravo Submission",
          house: "Bravo House",
          notes: ["b"],
        },
      );
      const subC = await env.actions.submitPerfumeAction(
        env.db.getDb(),
        aliceSession,
        {
          name: "Charlie Submission",
          house: "Charlie House",
          notes: ["c"],
        },
      );

      // Seed a canonical perfume that subA's resolution will reference.
      const canonicalPerfumeUri = await seedPerfume(
        env,
        "Alpha Canonical",
      );

      // Dispatch an approval resolution for subA.
      const approveEvt = makeEvent(
        "com.smellgate.perfumeSubmissionResolution",
        FAKE_CURATOR_DID,
        {
          $type: "com.smellgate.perfumeSubmissionResolution",
          submission: { uri: subA.uri, cid: FAKE_CID },
          decision: "approved",
          perfume: { uri: canonicalPerfumeUri, cid: FAKE_CID },
          createdAt: nowIso(),
        },
      );
      await env.tap.dispatchSmellgateEvent(env.db.getDb(), approveEvt);

      // Dispatch a rejection resolution for subB with a curator note.
      const rejectEvt = makeEvent(
        "com.smellgate.perfumeSubmissionResolution",
        FAKE_CURATOR_DID,
        {
          $type: "com.smellgate.perfumeSubmissionResolution",
          submission: { uri: subB.uri, cid: FAKE_CID },
          decision: "rejected",
          note: "Not enough detail.",
          createdAt: nowIso(),
        },
      );
      await env.tap.dispatchSmellgateEvent(env.db.getDb(), rejectEvt);

      // Now list alice's submissions.
      const items = await env.actions.listMySubmissionsAction(
        env.db.getDb(),
        aliceSession,
      );
      // Three submissions for this test, keyed by uri. Match by URI.
      const a = items.find((i) => i.uri === subA.uri);
      const b = items.find((i) => i.uri === subB.uri);
      const c = items.find((i) => i.uri === subC.uri);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(c).toBeDefined();
      expect(a?.state).toBe("approved");
      expect(a?.resolvedPerfumeUri).toBe(canonicalPerfumeUri);
      expect(b?.state).toBe("rejected");
      expect(b?.resolutionNote).toBe("Not enough detail.");
      expect(c?.state).toBe("pending");
    }, 120_000);
  });
});
