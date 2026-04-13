/**
 * Integration tests for Phase 3.C — the perfume submission flow,
 * curator approve/reject/duplicate actions, and the pending-record
 * rewrite mechanic (issue #55).
 *
 * These tests run against a real in-process PDS via real OAuth, a real
 * SQLite cache populated by the real Tap dispatcher, and the real
 * curator-DID enforcement from `lib/curators.ts`. No mocks.
 *
 * Test matrix (numbers match the issue body):
 *   1. Submission write — user creates a `perfumeSubmission` via
 *      `submitPerfumeAction`, asserts it lands on the user's PDS and
 *      in the cache.
 *   2. Curator approve flow — curator calls `approveSubmissionAction`,
 *      asserts both the canonical perfume and the resolution are
 *      written to the curator's PDS and indexed in the cache.
 *   3. Curator reject flow — resolution written with
 *      `decision: "rejected"`, no perfume created.
 *   4. Curator duplicate flow — resolution written with
 *      `decision: "duplicate"` and a non-null `perfume` ref.
 *   5. Approve rewrite end-to-end — user writes a pending review,
 *      curator approves, `rewritePendingRecords` runs, the user's
 *      review on their PDS now points at the canonical perfume.
 *   6. Duplicate rewrite end-to-end — same shape but via
 *      `decision: "duplicate"`.
 *   7. Reject — no rewrite — rejected resolutions are not candidates
 *      at all (the UI is responsible for prompting the user).
 *   8. Curator-gate — a non-curator session is denied 403 by the
 *      approve / reject / duplicate actions.
 *
 * Shared PDS and OAuth sessions: a single in-process PDS for the whole
 * describe block. `alice` is the user, `bob` is the curator (which
 * requires stubbing `SMELLGATE_CURATOR_DIDS` to bob's DID before the
 * cache modules are imported, since `lib/curators.ts` reads the env
 * once at module load).
 *
 * Cache handling: the cache is re-created per test via `freshCacheEnv`,
 * same as `tests/integration/server-actions.test.ts`. After a curator
 * action writes a record to their PDS, the test dispatches a synthetic
 * Tap event to the cache so that subsequent queries see it. The
 * dispatcher is the same code the production firehose path calls, so
 * this is a faithful stand-in.
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
import { AtUri } from "@atproto/syntax";
import {
  type EphemeralPds,
  createTestAccounts,
  createTestOAuthClient,
  startEphemeralPds,
  stopEphemeralPds,
  type TestAccountCreds,
} from "../helpers/pds";

const FAKE_CID = "bafkreic34bborvtv2pquhi5vt3yjjuhzdhmlnqx263wmc3br2fu63evfiy";

// -----------------------------------------------------------------------------
// Module reloading / env stubbing. `lib/curators.ts` reads
// SMELLGATE_CURATOR_DIDS at module-load time, so we stub the env and
// re-import per test. Bob is the curator; alice is the regular user.
// -----------------------------------------------------------------------------

type ActionsModule = typeof import("../../lib/server/smellgate-actions");
type CuratorModule =
  typeof import("../../lib/server/smellgate-curator-actions");
type QueriesModule = typeof import("../../lib/db/smellgate-queries");
type TapModule = typeof import("../../lib/tap/smellgate");
type DbIndexModule = typeof import("../../lib/db");
type MigrationsModule = typeof import("../../lib/db/migrations");

interface CacheEnv {
  actions: ActionsModule;
  curator: CuratorModule;
  queries: QueriesModule;
  tap: TapModule;
  db: DbIndexModule;
  dispose: () => void;
}

async function freshCacheEnv(curatorDids: string[]): Promise<CacheEnv> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-p3c-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  vi.stubEnv("SMELLGATE_CURATOR_DIDS", curatorDids.join(","));
  vi.resetModules();

  const migrations: MigrationsModule = await import("../../lib/db/migrations");
  const { error } = await migrations.getMigrator().migrateToLatest();
  if (error) throw error;

  const db: DbIndexModule = await import("../../lib/db");
  const tap: TapModule = await import("../../lib/tap/smellgate");
  const actions: ActionsModule = await import(
    "../../lib/server/smellgate-actions"
  );
  const curator: CuratorModule = await import(
    "../../lib/server/smellgate-curator-actions"
  );
  const queries: QueriesModule = await import(
    "../../lib/db/smellgate-queries"
  );

  return {
    actions,
    curator,
    queries,
    tap,
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

// -----------------------------------------------------------------------------
// Synthetic Tap-event builders used to re-feed cache rows after writes.
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
  rkey: string,
  record: Record<string, unknown>,
  cid: string = FAKE_CID,
  action: "create" | "update" = "create",
): RecordEvent {
  return {
    id: rkeyCounter++,
    type: "record",
    action,
    did,
    rev: "3kgaaaaaaaaa2",
    collection,
    rkey,
    record,
    cid,
    live: true,
  };
}

function atUriParts(uri: string): { did: string; collection: string; rkey: string } {
  const parsed = new AtUri(uri);
  return { did: parsed.hostname, collection: parsed.collection, rkey: parsed.rkey };
}

/**
 * Mirror a record that was written to a real PDS (by a real action)
 * into the cache by re-dispatching it as a synthetic Tap event. This
 * is exactly what the production firehose → webhook → dispatcher path
 * would do; we skip the network hops for test speed.
 */
async function indexRecordIntoCache(
  env: CacheEnv,
  uri: string,
  cid: string,
  record: Record<string, unknown>,
): Promise<void> {
  const { did, collection, rkey } = atUriParts(uri);
  const evt = makeEvent(collection, did, rkey, record, cid, "create");
  await env.tap.dispatchSmellgateEvent(env.db.getDb(), evt);
}

/**
 * Read a record back from a user's PDS via their OAuth session's
 * authenticated fetchHandler.
 */
async function getRecord(
  session: OAuthSession,
  uri: string,
): Promise<{ value: Record<string, unknown>; cid: string }> {
  const { did, collection, rkey } = atUriParts(uri);
  const url =
    `/xrpc/com.atproto.repo.getRecord` +
    `?repo=${encodeURIComponent(did)}` +
    `&collection=${encodeURIComponent(collection)}` +
    `&rkey=${encodeURIComponent(rkey)}`;
  const res = await session.fetchHandler(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`getRecord ${uri} failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    value: Record<string, unknown>;
    cid: string;
  };
  return body;
}

async function createRecord(
  session: OAuthSession,
  collection: string,
  record: Record<string, unknown>,
): Promise<{ uri: string; cid: string }> {
  const body = {
    repo: session.did,
    collection,
    record: { ...record, $type: collection },
  };
  const res = await session.fetchHandler(`/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `createRecord ${collection} failed (${res.status}): ${await res.text()}`,
    );
  }
  return (await res.json()) as { uri: string; cid: string };
}

// -----------------------------------------------------------------------------
// OAuth flow — same as `tests/integration/server-actions.test.ts`.
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
      "user-agent": "smellgate-p3c-test",
    },
  });
  jar.ingest(getSetCookies(pageRes.headers));
  if (pageRes.status !== 200) {
    throw new Error(`authorize page ${pageRes.status}: ${pageRes.body}`);
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
    "user-agent": "smellgate-p3c-test",
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
      "user-agent": "smellgate-p3c-test",
    },
  });
  const location = redirectRes.headers["location"];
  if (!location || Array.isArray(location)) {
    throw new Error(
      `redirect ${redirectRes.status} with no usable Location: ${redirectRes.body}`,
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
// Seed helper: a curator-authored canonical perfume row directly into
// the cache, used by the "mark duplicate" and "rewrite via duplicate"
// tests. The dispatcher gate accepts it because the stubbed curator
// DID list contains `curatorDid`.
// -----------------------------------------------------------------------------

async function seedCanonicalPerfume(
  env: CacheEnv,
  curatorDid: string,
  name: string,
): Promise<string> {
  const rkey = nextRkey();
  const record = {
    $type: "com.smellgate.perfume",
    name,
    house: "House",
    notes: ["test"],
    createdAt: nowIso(),
  };
  const evt = makeEvent("com.smellgate.perfume", curatorDid, rkey, record);
  await env.tap.dispatchSmellgateEvent(env.db.getDb(), evt);
  return `at://${curatorDid}/com.smellgate.perfume/${rkey}`;
}

// -----------------------------------------------------------------------------
// The test suite.
// -----------------------------------------------------------------------------

describe("smellgate submission + curator flow (Phase 3.C)", () => {
  let pds: EphemeralPds;
  let alice: TestAccountCreds;
  let bob: TestAccountCreds;
  let carol: TestAccountCreds;
  let aliceClient: NodeOAuthClient;
  let bobClient: NodeOAuthClient;
  let carolClient: NodeOAuthClient;
  let aliceSession: OAuthSession;
  let bobSession: OAuthSession;
  let carolSession: OAuthSession;

  beforeAll(async () => {
    pds = await startEphemeralPds();
    // alice = regular user, bob = curator, carol = second regular user
    // used by the cross-tenant rewrite-guard test (#61).
    const accounts = await createTestAccounts(pds, [
      { shortName: "alice", handle: "alice.test", password: "alice-pw" },
      { shortName: "bob", handle: "bob.test", password: "bob-pw" },
      { shortName: "carol", handle: "carol.test", password: "carol-pw" },
    ]);
    const a = accounts.find((x) => x.shortName === "alice");
    const b = accounts.find((x) => x.shortName === "bob");
    const c = accounts.find((x) => x.shortName === "carol");
    if (!a || !b || !c) throw new Error("alice/bob/carol not seeded");
    alice = a;
    bob = b;
    carol = c;
    aliceClient = createTestOAuthClient(pds);
    bobClient = createTestOAuthClient(pds);
    carolClient = createTestOAuthClient(pds);
    aliceSession = await completeOAuthFlow(aliceClient, alice.handle, alice.password);
    bobSession = await completeOAuthFlow(bobClient, bob.handle, bob.password);
    carolSession = await completeOAuthFlow(carolClient, carol.handle, carol.password);
    expect(aliceSession.did).toBe(alice.did);
    expect(bobSession.did).toBe(bob.did);
    expect(carolSession.did).toBe(carol.did);
  }, 240_000);

  afterAll(async () => {
    if (pds) await stopEphemeralPds(pds);
  });

  let env: CacheEnv;

  beforeEach(async () => {
    rkeyCounter = 0;
    // bob is the curator for all of these tests.
    env = await freshCacheEnv([bob.did]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  // ---------------------------------------------------------------------------
  // 1. Submission write
  // ---------------------------------------------------------------------------

  it("submitPerfumeAction writes a perfumeSubmission to the user's PDS and the cache picks it up", async () => {
    const result = await env.actions.submitPerfumeAction(
      env.db.getDb(),
      aliceSession,
      {
        name: "Test Eau",
        house: "Test House",
        notes: ["Rose", "rose", " Jasmine "],
        rationale: "Missing from catalog",
      },
    );
    expect(result.uri).toMatch(
      new RegExp(`^at://${alice.did}/com\\.smellgate\\.perfumeSubmission/`),
    );

    // Round-trip on the PDS.
    const fetched = await getRecord(aliceSession, result.uri);
    const value = fetched.value as {
      $type: string;
      name: string;
      house: string;
      notes: string[];
      rationale?: string;
    };
    expect(value.$type).toBe("com.smellgate.perfumeSubmission");
    expect(value.name).toBe("Test Eau");
    // Notes normalized: lowercase, trimmed, deduped.
    expect(value.notes).toEqual(["rose", "jasmine"]);
    expect(value.rationale).toBe("Missing from catalog");

    // Feed the cache via a synthetic dispatch using the real CID the
    // PDS returned. The PDS round-trips `$type` as part of `value`, so
    // we forward it as-is.
    await indexRecordIntoCache(env, result.uri, fetched.cid, {
      ...value,
    });
    const pending = await env.queries.getPendingSubmissions(env.db.getDb());
    expect(pending.map((p) => p.uri)).toContain(result.uri);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 2. Approve
  // ---------------------------------------------------------------------------

  it("approveSubmissionAction writes a canonical perfume and a resolution on the curator's PDS", async () => {
    // Alice submits.
    const sub = await env.actions.submitPerfumeAction(env.db.getDb(), aliceSession, {
      name: "Approvable",
      house: "House",
      notes: ["oud"],
    });
    const subFetched = await getRecord(aliceSession, sub.uri);
    await indexRecordIntoCache(env, sub.uri, subFetched.cid, {
      $type: "com.smellgate.perfumeSubmission",
      ...subFetched.value,
    });

    // Bob (curator) approves.
    const { perfumeUri, resolutionUri } = await env.curator.approveSubmissionAction(
      env.db.getDb(),
      bobSession,
      { submissionUri: sub.uri },
    );
    expect(perfumeUri).toMatch(
      new RegExp(`^at://${bob.did}/com\\.smellgate\\.perfume/`),
    );
    expect(resolutionUri).toMatch(
      new RegExp(`^at://${bob.did}/com\\.smellgate\\.perfumeSubmissionResolution/`),
    );

    // Records exist on bob's PDS.
    const perfumeRecord = await getRecord(bobSession, perfumeUri);
    expect((perfumeRecord.value as { $type: string }).$type).toBe(
      "com.smellgate.perfume",
    );
    expect((perfumeRecord.value as { name: string }).name).toBe("Approvable");
    const resolutionRecord = await getRecord(bobSession, resolutionUri);
    const rv = resolutionRecord.value as {
      $type: string;
      decision: string;
      submission: { uri: string };
      perfume?: { uri: string };
    };
    expect(rv.$type).toBe("com.smellgate.perfumeSubmissionResolution");
    expect(rv.decision).toBe("approved");
    expect(rv.submission.uri).toBe(sub.uri);
    expect(rv.perfume?.uri).toBe(perfumeUri);

    // Index both into cache and confirm the query layer sees them.
    await indexRecordIntoCache(env, perfumeUri, perfumeRecord.cid, {
      $type: "com.smellgate.perfume",
      ...perfumeRecord.value,
    });
    await indexRecordIntoCache(env, resolutionUri, resolutionRecord.cid, {
      $type: "com.smellgate.perfumeSubmissionResolution",
      ...resolutionRecord.value,
    });
    const cached = await env.queries.getPerfumeByUri(env.db.getDb(), perfumeUri);
    expect(cached?.name).toBe("Approvable");
    const res = await env.queries.getResolutionForSubmission(
      env.db.getDb(),
      sub.uri,
    );
    expect(res?.decision).toBe("approved");
    expect(res?.perfume_uri).toBe(perfumeUri);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 3. Reject
  // ---------------------------------------------------------------------------

  it("rejectSubmissionAction writes a rejected resolution with no perfume", async () => {
    const sub = await env.actions.submitPerfumeAction(env.db.getDb(), aliceSession, {
      name: "Rejectable",
      house: "House",
      notes: ["tar"],
    });
    const subFetched = await getRecord(aliceSession, sub.uri);
    await indexRecordIntoCache(env, sub.uri, subFetched.cid, {
      $type: "com.smellgate.perfumeSubmission",
      ...subFetched.value,
    });

    const { resolutionUri } = await env.curator.rejectSubmissionAction(
      env.db.getDb(),
      bobSession,
      { submissionUri: sub.uri, note: "Not a real perfume" },
    );

    const resolutionRecord = await getRecord(bobSession, resolutionUri);
    const rv = resolutionRecord.value as {
      decision: string;
      note?: string;
      perfume?: unknown;
    };
    expect(rv.decision).toBe("rejected");
    expect(rv.note).toBe("Not a real perfume");
    expect(rv.perfume).toBeUndefined();

    // No canonical perfume should have been created on bob's PDS for
    // this submission.
    const listRes = await bobSession.fetchHandler(
      `/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(bob.did)}&collection=com.smellgate.perfume&limit=100`,
      { method: "GET" },
    );
    const listBody = (await listRes.json()) as { records: { value: { name?: string } }[] };
    expect(
      listBody.records.find((r) => r.value.name === "Rejectable"),
    ).toBeUndefined();
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 4. Mark duplicate
  // ---------------------------------------------------------------------------

  it("markDuplicateAction writes a duplicate resolution pointing at an existing canonical perfume", async () => {
    // Pre-seed a canonical perfume authored by the curator DID.
    const canonicalUri = await seedCanonicalPerfume(env, bob.did, "Original");

    // Alice submits a near-duplicate.
    const sub = await env.actions.submitPerfumeAction(env.db.getDb(), aliceSession, {
      name: "Orig1nal",
      house: "House",
      notes: ["vanilla"],
    });
    const subFetched = await getRecord(aliceSession, sub.uri);
    await indexRecordIntoCache(env, sub.uri, subFetched.cid, {
      $type: "com.smellgate.perfumeSubmission",
      ...subFetched.value,
    });

    const { resolutionUri } = await env.curator.markDuplicateAction(
      env.db.getDb(),
      bobSession,
      { submissionUri: sub.uri, canonicalPerfumeUri: canonicalUri },
    );

    const resolutionRecord = await getRecord(bobSession, resolutionUri);
    const rv = resolutionRecord.value as {
      decision: string;
      perfume?: { uri: string };
    };
    expect(rv.decision).toBe("duplicate");
    expect(rv.perfume?.uri).toBe(canonicalUri);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 5. Approve rewrite end-to-end
  // ---------------------------------------------------------------------------

  it("rewritePendingRecords repoints a pending review to a newly-approved perfume", async () => {
    // Alice submits.
    const sub = await env.actions.submitPerfumeAction(env.db.getDb(), aliceSession, {
      name: "Pending Target",
      house: "House",
      notes: ["musk"],
    });
    const subFetched = await getRecord(aliceSession, sub.uri);
    await indexRecordIntoCache(env, sub.uri, subFetched.cid, {
      $type: "com.smellgate.perfumeSubmission",
      ...subFetched.value,
    });

    // Alice writes a pending review whose `perfume` strongRef is the
    // submission itself — exactly what the docs say happens when a
    // user reviews a perfume that hasn't been canonicalized yet.
    const reviewBody = "First impressions: unique.";
    const reviewCreate = await createRecord(
      aliceSession,
      "com.smellgate.review",
      {
        perfume: { uri: sub.uri, cid: subFetched.cid },
        rating: 7,
        sillage: 3,
        longevity: 4,
        body: reviewBody,
        createdAt: nowIso(),
      },
    );
    // Feed the pending review into the cache.
    await indexRecordIntoCache(env, reviewCreate.uri, reviewCreate.cid, {
      $type: "com.smellgate.review",
      perfume: { uri: sub.uri, cid: subFetched.cid },
      rating: 7,
      sillage: 3,
      longevity: 4,
      body: reviewBody,
      createdAt: nowIso(),
    });

    // Curator approves.
    const { perfumeUri } = await env.curator.approveSubmissionAction(
      env.db.getDb(),
      bobSession,
      { submissionUri: sub.uri },
    );
    const perfumeRec = await getRecord(bobSession, perfumeUri);
    await indexRecordIntoCache(env, perfumeUri, perfumeRec.cid, {
      $type: "com.smellgate.perfume",
      ...perfumeRec.value,
    });
    // And the resolution.
    const resUri = (
      await env.queries.getResolutionForSubmission(env.db.getDb(), sub.uri)
    )?.uri;
    // We don't have resUri yet in the cache — the approve call wrote to
    // the curator's PDS but the dispatcher hasn't seen the resolution.
    // Fetch it off the curator's PDS and feed it in.
    const listRes = await bobSession.fetchHandler(
      `/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(bob.did)}&collection=com.smellgate.perfumeSubmissionResolution&limit=100`,
      { method: "GET" },
    );
    const listBody = (await listRes.json()) as {
      records: { uri: string; cid: string; value: Record<string, unknown> }[];
    };
    const resolutionRow = listBody.records.find(
      (r) => (r.value as { submission: { uri: string } }).submission.uri === sub.uri,
    );
    expect(resolutionRow).toBeDefined();
    await indexRecordIntoCache(
      env,
      resolutionRow!.uri,
      resolutionRow!.cid,
      resolutionRow!.value,
    );
    expect(resUri).toBeUndefined(); // sanity: it wasn't there before we indexed it
    const nowRes = await env.queries.getResolutionForSubmission(
      env.db.getDb(),
      sub.uri,
    );
    expect(nowRes?.perfume_uri).toBe(perfumeUri);

    // Run the rewrite.
    const rewrite = await env.curator.rewritePendingRecords(
      env.db.getDb(),
      aliceSession,
    );
    expect(rewrite.failedUris).toEqual([]);
    expect(rewrite.rewrittenUris).toContain(reviewCreate.uri);

    // The review on alice's PDS should now point at the canonical
    // perfume, not the submission. This is the load-bearing assertion
    // for this test — it proves the putRecord edit actually happened.
    const updatedReview = await getRecord(aliceSession, reviewCreate.uri);
    const uv = updatedReview.value as {
      $type: string;
      perfume: { uri: string; cid: string };
      body: string;
      rating: number;
    };
    expect(uv.$type).toBe("com.smellgate.review");
    expect(uv.perfume.uri).toBe(perfumeUri);
    expect(uv.perfume.uri).not.toBe(sub.uri);
    // CID assertion (issue #60): the rewritten strongRef must point at
    // the canonical perfume's CID, not the submission's CID nor the
    // review's own CID. A regression that read the wrong CID source
    // would not be caught by the URI-only assertion above.
    expect(uv.perfume.cid).toBe(perfumeRec.cid);
    expect(uv.perfume.cid).not.toBe(subFetched.cid);
    // Other fields preserved.
    expect(uv.body).toBe(reviewBody);
    expect(uv.rating).toBe(7);

    // Feed the updated record through the dispatcher (as the firehose
    // would) and check the cache row now points at the canonical
    // perfume too.
    await indexRecordIntoCache(env, reviewCreate.uri, updatedReview.cid, {
      $type: "com.smellgate.review",
      ...updatedReview.value,
    });
    const reviewRow = await env.db
      .getDb()
      .selectFrom("smellgate_review")
      .selectAll()
      .where("uri", "=", reviewCreate.uri)
      .executeTakeFirst();
    expect(reviewRow?.perfume_uri).toBe(perfumeUri);
  }, 90_000);

  // ---------------------------------------------------------------------------
  // 6. Duplicate rewrite end-to-end
  // ---------------------------------------------------------------------------

  it("rewritePendingRecords repoints a pending shelfItem to an existing canonical perfume via duplicate", async () => {
    const canonicalUri = await seedCanonicalPerfume(env, bob.did, "Classic");
    const canonicalRow = await env.queries.getPerfumeByUri(
      env.db.getDb(),
      canonicalUri,
    );
    expect(canonicalRow).not.toBeNull();

    const sub = await env.actions.submitPerfumeAction(env.db.getDb(), aliceSession, {
      name: "Clasic",
      house: "House",
      notes: ["amber"],
    });
    const subFetched = await getRecord(aliceSession, sub.uri);
    await indexRecordIntoCache(env, sub.uri, subFetched.cid, {
      $type: "com.smellgate.perfumeSubmission",
      ...subFetched.value,
    });

    // Alice writes a pending shelfItem.
    const shelfCreate = await createRecord(
      aliceSession,
      "com.smellgate.shelfItem",
      {
        perfume: { uri: sub.uri, cid: subFetched.cid },
        bottleSizeMl: 50,
        isDecant: true,
        createdAt: nowIso(),
      },
    );
    await indexRecordIntoCache(env, shelfCreate.uri, shelfCreate.cid, {
      $type: "com.smellgate.shelfItem",
      perfume: { uri: sub.uri, cid: subFetched.cid },
      bottleSizeMl: 50,
      isDecant: true,
      createdAt: nowIso(),
    });

    // Curator marks duplicate.
    const { resolutionUri } = await env.curator.markDuplicateAction(
      env.db.getDb(),
      bobSession,
      { submissionUri: sub.uri, canonicalPerfumeUri: canonicalUri },
    );
    const resolutionRec = await getRecord(bobSession, resolutionUri);
    await indexRecordIntoCache(env, resolutionUri, resolutionRec.cid, {
      $type: "com.smellgate.perfumeSubmissionResolution",
      ...resolutionRec.value,
    });

    // Run the rewrite.
    const rewrite = await env.curator.rewritePendingRecords(
      env.db.getDb(),
      aliceSession,
    );
    expect(rewrite.failedUris).toEqual([]);
    expect(rewrite.rewrittenUris).toContain(shelfCreate.uri);

    const updatedShelf = await getRecord(aliceSession, shelfCreate.uri);
    const sv = updatedShelf.value as {
      $type: string;
      perfume: { uri: string; cid: string };
      bottleSizeMl?: number;
      isDecant?: boolean;
    };
    expect(sv.$type).toBe("com.smellgate.shelfItem");
    expect(sv.perfume.uri).toBe(canonicalUri);
    // CID assertion (issue #60): the rewritten strongRef must carry the
    // canonical perfume's CID, sourced from the cache row populated by
    // the dispatcher — not the submission's CID.
    expect(sv.perfume.cid).toBe(canonicalRow!.cid);
    expect(sv.perfume.cid).not.toBe(subFetched.cid);
    expect(sv.bottleSizeMl).toBe(50);
    expect(sv.isDecant).toBe(true);
  }, 90_000);

  // ---------------------------------------------------------------------------
  // 7. Reject — no rewrite
  // ---------------------------------------------------------------------------

  it("rewritePendingRecords does nothing when the resolution is a rejection", async () => {
    const sub = await env.actions.submitPerfumeAction(env.db.getDb(), aliceSession, {
      name: "NoRewrite",
      house: "House",
      notes: ["smoke"],
    });
    const subFetched = await getRecord(aliceSession, sub.uri);
    await indexRecordIntoCache(env, sub.uri, subFetched.cid, {
      $type: "com.smellgate.perfumeSubmission",
      ...subFetched.value,
    });

    // Alice writes a pending description.
    const body = "This smells unfinished.";
    const descCreate = await createRecord(
      aliceSession,
      "com.smellgate.description",
      {
        perfume: { uri: sub.uri, cid: subFetched.cid },
        body,
        createdAt: nowIso(),
      },
    );
    await indexRecordIntoCache(env, descCreate.uri, descCreate.cid, {
      $type: "com.smellgate.description",
      perfume: { uri: sub.uri, cid: subFetched.cid },
      body,
      createdAt: nowIso(),
    });

    // Curator rejects.
    const { resolutionUri } = await env.curator.rejectSubmissionAction(
      env.db.getDb(),
      bobSession,
      { submissionUri: sub.uri, note: "nope" },
    );
    const resolutionRec = await getRecord(bobSession, resolutionUri);
    await indexRecordIntoCache(env, resolutionUri, resolutionRec.cid, {
      $type: "com.smellgate.perfumeSubmissionResolution",
      ...resolutionRec.value,
    });

    // Run the rewrite — it should be a no-op.
    const rewrite = await env.curator.rewritePendingRecords(
      env.db.getDb(),
      aliceSession,
    );
    expect(rewrite.rewrittenUris).toEqual([]);
    expect(rewrite.failedUris).toEqual([]);

    // The description on alice's PDS still points at the submission URI.
    const stillPending = await getRecord(aliceSession, descCreate.uri);
    const dv = stillPending.value as { perfume: { uri: string } };
    expect(dv.perfume.uri).toBe(sub.uri);
  }, 90_000);

  // ---------------------------------------------------------------------------
  // 8. Curator-gate — non-curator cannot approve / reject / duplicate.
  // ---------------------------------------------------------------------------

  it("non-curator sessions get 403 from curator actions", async () => {
    // Alice (not in curator list) submits.
    const sub = await env.actions.submitPerfumeAction(env.db.getDb(), aliceSession, {
      name: "Gated",
      house: "House",
      notes: ["iris"],
    });
    const subFetched = await getRecord(aliceSession, sub.uri);
    await indexRecordIntoCache(env, sub.uri, subFetched.cid, {
      $type: "com.smellgate.perfumeSubmission",
      ...subFetched.value,
    });

    // Alice tries to self-approve — should be denied.
    await expect(
      env.curator.approveSubmissionAction(env.db.getDb(), aliceSession, {
        submissionUri: sub.uri,
      }),
    ).rejects.toMatchObject({ name: "ActionError", status: 403 });

    await expect(
      env.curator.rejectSubmissionAction(env.db.getDb(), aliceSession, {
        submissionUri: sub.uri,
      }),
    ).rejects.toMatchObject({ name: "ActionError", status: 403 });

    await expect(
      env.curator.markDuplicateAction(env.db.getDb(), aliceSession, {
        submissionUri: sub.uri,
        canonicalPerfumeUri: "at://did:plc:x/com.smellgate.perfume/x",
      }),
    ).rejects.toMatchObject({ name: "ActionError", status: 403 });

    await expect(
      env.curator.listPendingSubmissionsAction(env.db.getDb(), aliceSession),
    ).rejects.toMatchObject({ name: "ActionError", status: 403 });
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 9. Cross-tenant rewrite guard (issue #61).
  //
  // `getPendingRecordsForUser` filters by `u.author_did = authorDid`,
  // which is the load-bearing guarantee that one user's call to
  // `rewritePendingRecords` can never touch another user's records.
  // This test exercises that guarantee end-to-end:
  //
  //   1. Alice submits a perfume and writes a pending review against it.
  //   2. Bob (curator) approves the submission.
  //   3. Carol — a completely separate authenticated user — calls
  //      `rewritePendingRecords` with her own session. The call MUST
  //      report no rewrites and Alice's review on her PDS MUST be
  //      unchanged (still pointing at the submission URI).
  //   4. CONTROL: Alice then calls `rewritePendingRecords` with her own
  //      session and we assert the review IS rewritten. Without this
  //      control the test could pass even if rewrites were globally
  //      broken (e.g. always returning empty), so the cross-tenant
  //      assertion would be vacuous.
  // ---------------------------------------------------------------------------

  it("rewritePendingRecords is scoped to the calling user (cross-tenant guard)", async () => {
    // Alice submits.
    const sub = await env.actions.submitPerfumeAction(env.db.getDb(), aliceSession, {
      name: "Tenant Target",
      house: "House",
      notes: ["leather"],
    });
    const subFetched = await getRecord(aliceSession, sub.uri);
    await indexRecordIntoCache(env, sub.uri, subFetched.cid, {
      $type: "com.smellgate.perfumeSubmission",
      ...subFetched.value,
    });

    // Alice writes a pending review against her own submission.
    const reviewBody = "Alice's pending take.";
    const reviewCreate = await createRecord(
      aliceSession,
      "com.smellgate.review",
      {
        perfume: { uri: sub.uri, cid: subFetched.cid },
        rating: 6,
        sillage: 2,
        longevity: 3,
        body: reviewBody,
        createdAt: nowIso(),
      },
    );
    await indexRecordIntoCache(env, reviewCreate.uri, reviewCreate.cid, {
      $type: "com.smellgate.review",
      perfume: { uri: sub.uri, cid: subFetched.cid },
      rating: 6,
      sillage: 2,
      longevity: 3,
      body: reviewBody,
      createdAt: nowIso(),
    });

    // Bob (curator) approves Alice's submission.
    const { perfumeUri } = await env.curator.approveSubmissionAction(
      env.db.getDb(),
      bobSession,
      { submissionUri: sub.uri },
    );
    const perfumeRec = await getRecord(bobSession, perfumeUri);
    await indexRecordIntoCache(env, perfumeUri, perfumeRec.cid, {
      $type: "com.smellgate.perfume",
      ...perfumeRec.value,
    });
    // Pull the resolution off the curator's PDS and feed it into the
    // cache so the rewrite query can see it.
    const listRes = await bobSession.fetchHandler(
      `/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(bob.did)}&collection=com.smellgate.perfumeSubmissionResolution&limit=100`,
      { method: "GET" },
    );
    const listBody = (await listRes.json()) as {
      records: { uri: string; cid: string; value: Record<string, unknown> }[];
    };
    const resolutionRow = listBody.records.find(
      (r) => (r.value as { submission: { uri: string } }).submission.uri === sub.uri,
    );
    expect(resolutionRow).toBeDefined();
    await indexRecordIntoCache(
      env,
      resolutionRow!.uri,
      resolutionRow!.cid,
      resolutionRow!.value,
    );

    // ---- Cross-tenant call: Carol triggers rewrite with her session.
    // She has no pending records of her own and crucially must not see
    // Alice's. Expected outcome: empty rewrittenUris and Alice's review
    // is untouched on her PDS.
    const carolRewrite = await env.curator.rewritePendingRecords(
      env.db.getDb(),
      carolSession,
    );
    expect(carolRewrite.rewrittenUris).toEqual([]);
    expect(carolRewrite.failedUris).toEqual([]);

    // Alice's review must STILL point at the submission URI/CID, not
    // the canonical perfume — Carol's call must not have touched it.
    const aliceReviewAfterCarol = await getRecord(aliceSession, reviewCreate.uri);
    const arav = aliceReviewAfterCarol.value as {
      perfume: { uri: string; cid: string };
    };
    expect(arav.perfume.uri).toBe(sub.uri);
    expect(arav.perfume.cid).toBe(subFetched.cid);
    expect(arav.perfume.uri).not.toBe(perfumeUri);

    // ---- Control: Alice triggers her own rewrite. The same record
    // must now be rewritten to the canonical perfume. Without this
    // control, the cross-tenant assertion above could pass trivially
    // (e.g. if rewrites were globally broken).
    const aliceRewrite = await env.curator.rewritePendingRecords(
      env.db.getDb(),
      aliceSession,
    );
    expect(aliceRewrite.failedUris).toEqual([]);
    expect(aliceRewrite.rewrittenUris).toContain(reviewCreate.uri);

    const aliceReviewAfterSelf = await getRecord(aliceSession, reviewCreate.uri);
    const asav = aliceReviewAfterSelf.value as {
      perfume: { uri: string; cid: string };
    };
    expect(asav.perfume.uri).toBe(perfumeUri);
    expect(asav.perfume.cid).toBe(perfumeRec.cid);
  }, 120_000);
});
