/**
 * Cache rebuild script.
 *
 * DO NOT RUN against a production cache without taking a backup first.
 * Even though the rebuild is idempotent (upserts) and the drop is a
 * row-clear rather than a schema drop, the drop step is destructive —
 * any rows that can't be re-fetched from the network (e.g. because a
 * PDS is unreachable) will be gone until the next firehose event lands.
 *
 * Per AGENTS.md: "The only local storage is the auth session store and
 * a Tap-fed read cache — never treat it as authoritative." This script
 * proves that's true by dropping the smellgate cache rows and
 * rebuilding them by replaying `com.atproto.repo.listRecords` against
 * the PDS of every author DID we've seen.
 *
 * Design:
 *
 * 1. Enumerate the set of author DIDs from the existing cache (across
 *    every `smellgate_*` table). This is approach (c) from the issue:
 *    walk the local cache, drop it, re-fetch per DID, dispatch. The
 *    bootstrap problem of "if the cache is empty you can't rebuild it"
 *    is documented and considered acceptable — it means "empty goes to
 *    empty," which is already the desired behavior.
 * 2. DELETE FROM every smellgate_* table. (Schema is left intact — the
 *    migration is not re-run.)
 * 3. For each DID × collection, call the PUBLIC, UNAUTHENTICATED XRPC
 *    endpoint `com.atproto.repo.listRecords`. No OAuth. If a DID's PDS
 *    is unreachable, log and skip.
 * 4. For each record, construct a synthetic Tap `RecordEvent` whose
 *    shape matches what the firehose would produce, and call
 *    `dispatchSmellgateEvent` — the exact same function the production
 *    webhook calls. The dispatcher re-runs lexicon validation,
 *    curator-gate enforcement, and closed-enum checks, so a rebuilt
 *    cache is indistinguishable from a firehose-populated one.
 * 5. Report per-collection counts and total time.
 *
 * Configuration:
 *
 *   SMELLGATE_REBUILD_PDS_URL   Base PDS URL. Default: https://bsky.social
 *                               (the script calls listRecords on this URL
 *                               for every discovered DID; the PDS will
 *                               route the request to the correct repo.)
 *   SMELLGATE_REBUILD_DRY_RUN   If "1", do not drop or rebuild; just
 *                               report what WOULD happen. Also enabled
 *                               by passing `--dry-run` on the command
 *                               line.
 *   SMELLGATE_CURATOR_DIDS      Required for the dispatcher to accept
 *                               curator-only records (perfume,
 *                               perfumeSubmissionResolution). Inherited
 *                               from the normal app config.
 *   DATABASE_PATH               Inherited from `lib/db/index.ts`.
 *
 * The script NEVER writes to a PDS. It is read-only as far as the
 * network is concerned. If you find yourself adding an auth header to
 * an outgoing PDS call, stop — you are calling the wrong endpoint.
 */

import { Kysely } from "kysely";
import type { RecordEvent } from "@atproto/tap";
import { getDb, type DatabaseSchema } from "../lib/db";
import {
  dispatchSmellgateEvent,
  SMELLGATE_COLLECTIONS,
  SMELLGATE_COLLECTION_LIST,
} from "../lib/tap/smellgate";

const DEFAULT_PDS_URL = "https://bsky.social";
const LIST_PAGE_LIMIT = 100;

// The set of tables whose rows get cleared on drop. Join tables come
// first so the parent-table delete doesn't leave dangling note rows —
// though with no foreign keys it doesn't really matter, we do it for
// symmetry with the migration's `down()`.
const CACHE_TABLES: readonly (keyof DatabaseSchema)[] = [
  "smellgate_perfume_note",
  "smellgate_perfume",
  "smellgate_perfume_submission_note",
  "smellgate_perfume_submission",
  "smellgate_perfume_submission_resolution",
  "smellgate_shelf_item",
  "smellgate_review",
  "smellgate_description",
  "smellgate_vote",
  "smellgate_comment",
] as const;

// Which tables have an `author_did` column we can enumerate DIDs from.
// (The note join tables do not — they reference the parent row by URI
// only.) Note that `smellgate_perfume` and
// `smellgate_perfume_submission_resolution` are curator-only, so their
// author_dids will be the curator DID — still fine to include, since
// the curator publishes canonical records from their own PDS.
const DID_SOURCE_TABLES = [
  "smellgate_perfume",
  "smellgate_perfume_submission",
  "smellgate_perfume_submission_resolution",
  "smellgate_shelf_item",
  "smellgate_review",
  "smellgate_description",
  "smellgate_vote",
  "smellgate_comment",
] as const;

export type RebuildOptions = {
  /** Base PDS URL the script reads from. */
  pdsUrl: string;
  /** If true, report intent but do nothing destructive. */
  dryRun: boolean;
  /**
   * Optional explicit DID list. When set, the script uses this instead
   * of enumerating DIDs from the cache. Primarily for tests and for
   * operators who already know the set of authors to re-index.
   */
  dids?: readonly string[];
  /** Sink for progress output. Defaults to `console.log`. */
  log?: (msg: string) => void;
};

export type RebuildReport = {
  dryRun: boolean;
  pdsUrl: string;
  didsConsidered: number;
  listedRecords: number;
  dispatched: number;
  perCollection: Record<string, number>;
  elapsedMs: number;
};

type ListRecordsResponse = {
  cursor?: string;
  records: Array<{
    uri: string;
    cid: string;
    value: Record<string, unknown>;
  }>;
};

// ---------------------------------------------------------------------------
// Public entry point: importable from tests without spawning a process.
// ---------------------------------------------------------------------------

export async function rebuildCache(
  db: Kysely<DatabaseSchema>,
  opts: RebuildOptions,
): Promise<RebuildReport> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const t0 = Date.now();

  log(`[rebuild] pdsUrl=${opts.pdsUrl} dryRun=${opts.dryRun}`);

  // 1. Collect the set of DIDs to re-index BEFORE dropping anything.
  const dids =
    opts.dids && opts.dids.length > 0
      ? [...new Set(opts.dids)]
      : await collectAuthorDids(db);
  log(`[rebuild] discovered ${dids.length} author DIDs to re-index`);

  const perCollection: Record<string, number> = Object.fromEntries(
    SMELLGATE_COLLECTION_LIST.map((c) => [c, 0]),
  );

  if (opts.dryRun) {
    // Still list records so we can report what *would* happen. We do
    // NOT drop or dispatch.
    let listed = 0;
    for (const did of dids) {
      for (const collection of SMELLGATE_COLLECTION_LIST) {
        const recs = await listAllRecords(opts.pdsUrl, did, collection, log);
        listed += recs.length;
        perCollection[collection] = (perCollection[collection] ?? 0) + recs.length;
      }
    }
    const elapsedMs = Date.now() - t0;
    log(
      `[rebuild] DRY RUN: would drop ${CACHE_TABLES.length} tables and re-dispatch ${listed} records`,
    );
    logPerCollection(perCollection, log);
    log(`[rebuild] done in ${elapsedMs}ms (dry run)`);
    return {
      dryRun: true,
      pdsUrl: opts.pdsUrl,
      didsConsidered: dids.length,
      listedRecords: listed,
      dispatched: 0,
      perCollection,
      elapsedMs,
    };
  }

  // 2. Drop all smellgate_* rows. Schema stays.
  log(`[rebuild] dropping rows from ${CACHE_TABLES.length} smellgate_* tables`);
  await dropAllCacheRows(db);

  // 3. For each DID × collection, list records and dispatch.
  let listedRecords = 0;
  let dispatched = 0;
  for (const did of dids) {
    for (const collection of SMELLGATE_COLLECTION_LIST) {
      let recs: ListRecordsResponse["records"];
      try {
        recs = await listAllRecords(opts.pdsUrl, did, collection, log);
      } catch (err) {
        log(
          `[rebuild] listRecords failed for ${did} ${collection}: ${errString(err)} (skipping)`,
        );
        continue;
      }
      listedRecords += recs.length;

      for (const rec of recs) {
        const evt = toRecordEvent(did, collection, rec);
        if (!evt) continue;
        try {
          await dispatchSmellgateEvent(db, evt);
          dispatched += 1;
          perCollection[collection] = (perCollection[collection] ?? 0) + 1;
        } catch (err) {
          log(`[rebuild] dispatch failed for ${rec.uri}: ${errString(err)}`);
        }
      }
    }
  }

  const elapsedMs = Date.now() - t0;
  log(`[rebuild] listed=${listedRecords} dispatched=${dispatched}`);
  logPerCollection(perCollection, log);
  log(`[rebuild] done in ${elapsedMs}ms`);

  return {
    dryRun: false,
    pdsUrl: opts.pdsUrl,
    didsConsidered: dids.length,
    listedRecords,
    dispatched,
    perCollection,
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Enumerate the union of `author_did` across every smellgate_* cache
 * table that has such a column. Runs BEFORE the drop so we know who to
 * re-fetch from.
 */
export async function collectAuthorDids(
  db: Kysely<DatabaseSchema>,
): Promise<string[]> {
  const seen = new Set<string>();
  for (const table of DID_SOURCE_TABLES) {
    const rows = await db
      .selectFrom(table)
      .select("author_did")
      .distinct()
      .execute();
    for (const row of rows) seen.add(row.author_did);
  }
  return Array.from(seen).sort();
}

/** DELETE FROM every smellgate_* table. Schema is not touched. */
export async function dropAllCacheRows(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    for (const table of CACHE_TABLES) {
      await tx.deleteFrom(table).execute();
    }
  });
}

/**
 * Page through `com.atproto.repo.listRecords` for one (repo, collection)
 * pair. Returns all records flattened. This endpoint is PUBLIC — no
 * auth header, no OAuth.
 */
async function listAllRecords(
  pdsUrl: string,
  did: string,
  collection: string,
  log: (msg: string) => void,
): Promise<ListRecordsResponse["records"]> {
  const out: ListRecordsResponse["records"] = [];
  let cursor: string | undefined;
  // Bound the loop so a buggy server can't spin us forever. 10k records
  // per (repo, collection) is far above anything we'd expect.
  for (let page = 0; page < 100; page++) {
    const url = new URL("/xrpc/com.atproto.repo.listRecords", pdsUrl);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", collection);
    url.searchParams.set("limit", String(LIST_PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      // 400 "RecordNotFound" / "InvalidRequest" for a repo that has no
      // records in this collection is not an error — just return empty.
      // We only log and throw for genuinely bad statuses.
      if (res.status === 400) return out;
      throw new Error(
        `listRecords ${res.status} for ${did} ${collection}: ${await safeText(res)}`,
      );
    }
    const body = (await res.json()) as ListRecordsResponse;
    for (const rec of body.records) out.push(rec);
    if (!body.cursor || body.records.length === 0) break;
    cursor = body.cursor;
  }
  if (out.length > 0) {
    log(`[rebuild] listed ${out.length} ${collection} for ${did}`);
  }
  return out;
}

/**
 * Convert a `listRecords` response row into a synthetic `RecordEvent`
 * that `dispatchSmellgateEvent` will accept. The rkey is parsed out of
 * the AT-URI; rev is a placeholder (the dispatcher never reads it); the
 * event is always a `create` — idempotency is handled at the handler
 * level via `ON CONFLICT (uri) DO UPDATE`.
 */
export function toRecordEvent(
  did: string,
  collection: string,
  rec: ListRecordsResponse["records"][number],
): RecordEvent | null {
  // at://did/collection/rkey
  const parts = rec.uri.split("/");
  const rkey = parts[parts.length - 1];
  if (!rkey) return null;
  return {
    id: 0,
    type: "record",
    action: "create",
    did,
    rev: "rebuild",
    collection,
    rkey,
    record: rec.value,
    cid: rec.cid,
    live: true,
  };
}

function logPerCollection(
  perCollection: Record<string, number>,
  log: (msg: string) => void,
): void {
  const ordered = Object.values(SMELLGATE_COLLECTIONS);
  for (const col of ordered) {
    const n = perCollection[col] ?? 0;
    log(`[rebuild]   ${col}: ${n}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
}

function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// CLI entry point. Invoked when run via `tsx scripts/rebuild-cache.ts`.
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): { dryRun: boolean } {
  let dryRun = process.env.SMELLGATE_REBUILD_DRY_RUN === "1";
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
  }
  return { dryRun };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const pdsUrl = process.env.SMELLGATE_REBUILD_PDS_URL ?? DEFAULT_PDS_URL;
  const db = getDb();
  const report = await rebuildCache(db, { pdsUrl, dryRun });
  console.log(`[rebuild] report: ${JSON.stringify(report, null, 2)}`);
}

// `import.meta.url` comparison detects "run as main script" under tsx.
// When imported as a module (from tests), `main()` is not invoked.
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
