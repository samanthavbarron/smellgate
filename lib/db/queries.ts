import { getDb, AccountTable, StatusTable, DatabaseSchema } from ".";
import { AtUri } from "@atproto/syntax";
import { getHandle, isValidDidDoc } from "@atproto/common-web";
import { resolveDid as resolveDidViaTap } from "@/lib/tap";
import { Transaction } from "kysely";

/**
 * Timeout (ms) applied to the public PLC fallback in `getAccountHandle`.
 * 3s is enough for plc.directory's p99 (~200ms) with plenty of headroom,
 * and short enough that a stalled/down directory doesn't block a page
 * render for visibly longer than the page's own budget.
 */
const PLC_FALLBACK_TIMEOUT_MS = 3000;

/**
 * Resolve the public PLC directory URL. In test / dev-network environments
 * `SMELLGATE_DEV_PLC_URL` points at the in-process PLC spun up by
 * `scripts/dev-network.ts` (or a test fixture); elsewhere we fall back to
 * the real `https://plc.directory`. Mirrors the dev-network gate in
 * `lib/auth/client.ts` so integration tests never hit the public internet.
 */
function getPlcDirectoryUrl(): string {
  return process.env.SMELLGATE_DEV_PLC_URL || "https://plc.directory";
}

/**
 * Fallback path for `getAccountHandle`: resolve a DID against the public
 * PLC directory and pull the primary handle from its `alsoKnownAs` entry.
 * `fetch` is browser-native in Node 18+; no new dependency. Any failure
 * (4xx, network error, timeout, malformed doc) returns `null` — the
 * caller (e.g. profile page) is already tolerant of a missing handle and
 * we prefer "render with placeholder" over "500 the page".
 */
async function resolveHandleFromPlc(did: string): Promise<string | null> {
  const base = getPlcDirectoryUrl();
  const url = `${base.replace(/\/+$/, "")}/${encodeURIComponent(did)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLC_FALLBACK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const doc: unknown = await res.json();
    if (!isValidDidDoc(doc)) return null;
    return getHandle(doc) ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getAccountHandle(did: string): Promise<string | null> {
  const db = getDb();
  // If we've tracked the account through Tap and have its handle in the
  // local cache, fast-path from there.
  const account = await db
    .selectFrom("account")
    .select("handle")
    .where("did", "=", did)
    .executeTakeFirst();
  if (account) return account.handle;

  // Next, try Tap's identity resolver. This is the in-process cached
  // resolver when Tap is attached; cheaper than a public lookup.
  // `resolveDidViaTap` uses the pre-patch fetch (see lib/tap/index.ts
  // for the Next.js 16 patch-fetch hang on `.internal` URLs) and has
  // its own timeout, so it cannot stall the render path.
  try {
    const didDoc = await resolveDidViaTap(did);
    if (didDoc && isValidDidDoc(didDoc)) {
      const handle = getHandle(didDoc) ?? null;
      if (handle) {
        await writeThroughAccountHandle(did, handle);
        return handle;
      }
    }
  } catch {
    // `resolveDidViaTap` swallows errors and returns null in production,
    // but tests stub the inner method to throw to exercise the fall-
    // through. Keep this catch so a thrown resolver can't 500 a render.
  }

  // Last resort: hit the public PLC directory directly. This is the gap
  // that issue #109 existed to close — when Tap is down or lagging, a
  // page rendering a foreign DID shouldn't 404. On success we write
  // through to the local cache so subsequent page renders are
  // synchronous; handle renames will get picked up by Tap's firehose
  // subscription the usual way (there is no TTL on the cached row —
  // follow-up for #109 if this becomes a problem in practice).
  const handle = await resolveHandleFromPlc(did);
  if (handle) {
    await writeThroughAccountHandle(did, handle);
    return handle;
  }
  return null;
}

/**
 * Populate the `account` cache with a handle resolved outside Tap's
 * normal ingestion path. `active` defaults to 1 — we only have positive
 * signal that the DID resolves; Tap's `#account` events will rewrite
 * this row with the authoritative value when it sees them. Best-effort:
 * a DB write failure must not block the page render.
 */
async function writeThroughAccountHandle(
  did: string,
  handle: string,
): Promise<void> {
  try {
    await getDb()
      .insertInto("account")
      .values({ did, handle, active: 1 })
      .onConflict((oc) =>
        oc.column("did").doUpdateSet({ handle, active: 1 }),
      )
      .execute();
  } catch {
    // Don't crash a page render on a cache-write miss. The next visit
    // will retry the resolve.
  }
}

export async function getAccountStatus(did: string) {
  const db = getDb();
  const status = await db
    .selectFrom("status")
    .selectAll()
    .where("authorDid", "=", did)
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst();
  return status ?? null;
}

export async function getRecentStatuses(limit = 5) {
  const db = getDb();
  return db
    .selectFrom("status")
    .innerJoin("account", "status.authorDid", "account.did")
    .selectAll()
    .orderBy("createdAt", "desc")
    .limit(limit)
    .execute();
}

export async function getTopStatuses(limit = 10) {
  const db = getDb();
  return db
    .selectFrom("status")
    .select(["status", db.fn.count("uri").as("count")])
    .where("current", "=", 1)
    .groupBy("status")
    .orderBy("count", "desc")
    .limit(limit)
    .execute();
}

export async function insertStatus(data: StatusTable) {
  getDb()
    .transaction()
    .execute(async (tx) => {
      await tx
        .insertInto("status")
        .values(data)
        .onConflict((oc) =>
          oc.column("uri").doUpdateSet({
            status: data.status,
            createdAt: data.createdAt,
            indexedAt: data.indexedAt,
          }),
        )
        .execute();
      setCurrStatus(tx, data.authorDid);
    });
}

export async function deleteStatus(uri: AtUri) {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      await tx.deleteFrom("status").where("uri", "=", uri.toString()).execute();
      await setCurrStatus(tx, uri.hostname);
    });
}

export async function upsertAccount(data: AccountTable) {
  await getDb()
    .insertInto("account")
    .values(data)
    .onConflict((oc) =>
      oc.column("did").doUpdateSet({
        handle: data.handle,
        active: data.active,
      }),
    )
    .execute();
}

export async function deleteAccount(did: string) {
  await getDb().deleteFrom("account").where("did", "=", did).execute();
  await getDb().deleteFrom("status").where("authorDid", "=", did).execute();
}

// Helper to update which status is "current" for a user (inside a transaction)
async function setCurrStatus(tx: Transaction<DatabaseSchema>, did: string) {
  // Clear current flag for all user's statuses
  await tx
    .updateTable("status")
    .set({ current: 0 })
    .where("authorDid", "=", did)
    .where("current", "=", 1)
    .execute();
  // Set the most recent status as current
  await tx
    .updateTable("status")
    .set({ current: 1 })
    .where("uri", "=", (qb) =>
      qb
        .selectFrom("status")
        .select("uri")
        .where("authorDid", "=", did)
        .orderBy("createdAt", "desc")
        .limit(1),
    )
    .execute();
}
