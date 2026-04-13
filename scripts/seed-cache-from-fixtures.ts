#!/usr/bin/env tsx
/**
 * scripts/seed-cache-from-fixtures.ts
 *
 * **DEV-ONLY.** Populates the local read cache with the synthetic seed
 * catalog from `tests/fixtures/seed-catalog.json` so the Phase 4.A home
 * page has something to render when you hit it in a browser. This
 * script exists purely to unblock local UI work — it does **not**
 * write to any PDS, it does not perform OAuth, and it must never be
 * run against a production database.
 *
 * What it does:
 *
 *   1. Loads the seed catalog JSON.
 *   2. Synthesises a single fake "curator" DID (`did:plc:smellgate-dev-curator`)
 *      and sets `SMELLGATE_CURATOR_DIDS` to it BEFORE importing the
 *      dispatcher — the dispatcher's curator gate reads that env var
 *      at module load. The DID is a placeholder; nothing on the real
 *      network matches it.
 *   3. For each seed entry, builds a synthetic `RecordEvent` for a
 *      `com.smellgate.perfume` create and calls
 *      `dispatchSmellgateEvent`, which is the same code path the Tap
 *      firehose uses in production. This means the cache rows written
 *      here are shape-identical to live rows.
 *   4. Optionally writes a few synthetic reviews against the first
 *      handful of seeded perfumes, so the home page's "recent reviews"
 *      section has content. Reviews are authored by a second fake DID
 *      that is NOT a curator.
 *
 * Idempotent: the dispatcher upserts on `uri`, so re-running the
 * script just rewrites the same rows. Safe to run before `pnpm dev` as
 * often as you like.
 *
 * Usage:
 *
 *     pnpm dev:seed-cache
 *
 * After running, `pnpm dev` will boot with a populated cache and the
 * home page will show 12 perfumes and 6 reviews.
 */

// IMPORTANT: set the curator env BEFORE importing the dispatcher — the
// `lib/curators` module parses it at import time and freezes the list.
// ES module `import` statements are hoisted, so we cannot use them for
// the dispatcher here; we use dynamic `await import()` after setting
// the env instead.
const DEV_CURATOR_DID = "did:plc:smellgate-dev-curator";
const DEV_REVIEWER_DID = "did:plc:smellgate-dev-reviewer";
process.env.SMELLGATE_CURATOR_DIDS = DEV_CURATOR_DID;

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordEvent } from "@atproto/tap";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SEED_PATH = join(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "seed-catalog.json",
);

type SeedEntry = {
  _seed?: { synthetic: boolean; id: string };
  $type: string;
  name: string;
  house: string;
  creator?: string;
  releaseYear?: number;
  notes: string[];
  description?: string;
  createdAt: string;
};

/**
 * A single known-valid CIDv1 that round-trips through `multiformats`
 * CID parsing. The lexicon's `format: cid` validator runs strongRef
 * cids through `multiformats`, and a made-up string won't parse — so
 * we reuse the same known-good constant for every synthetic record.
 * The cache is keyed on record `uri`, not cid, so sharing one cid
 * across seed records is harmless locally.
 */
const DEV_CID = "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

function fakeCid(_seed: string): string {
  return DEV_CID;
}

function perfumeRkey(seedId: string): string {
  // Reuse the seed id as the rkey so re-runs are idempotent.
  return seedId.replace(/[^a-z0-9]/gi, "").toLowerCase() || "unknown";
}

function buildPerfumeEvent(entry: SeedEntry, seedId: string): RecordEvent {
  const rkey = perfumeRkey(seedId);
  const record = {
    $type: "com.smellgate.perfume",
    name: entry.name,
    house: entry.house,
    creator: entry.creator,
    releaseYear: entry.releaseYear,
    notes: entry.notes,
    description: entry.description,
    createdAt: entry.createdAt,
  };
  return {
    id: 0,
    type: "record",
    action: "create",
    did: DEV_CURATOR_DID,
    rev: "dev-seed",
    collection: "com.smellgate.perfume",
    rkey,
    record,
    cid: fakeCid(`perfume-${seedId}`),
    live: true,
  };
}

function buildReviewEvent(
  perfumeUri: string,
  perfumeCid: string,
  idx: number,
): RecordEvent {
  const rkey = `review${idx.toString().padStart(3, "0")}`;
  const bodies = [
    "Opens bright and fades into a soft, powdery drydown. Nothing aggressive.",
    "The note pyramid on paper is one thing; on skin it feels older, heavier, better.",
    "Good projection for the first hour, then it hugs the skin for the rest of the day.",
    "A quiet scent. I reach for it when I don't want to be noticed but want to feel put together.",
    "Linear but in a good way — you get the same impression in hour six as in minute one.",
    "Feels like a vintage reference pulled forward. Not a thing I'd wear to an interview.",
  ];
  const ratings = [7, 8, 6, 9, 7, 8];
  const record = {
    $type: "com.smellgate.review",
    perfume: { uri: perfumeUri, cid: perfumeCid },
    rating: ratings[idx % ratings.length],
    sillage: 3,
    longevity: 4,
    body: bodies[idx % bodies.length],
    createdAt: new Date(Date.now() - idx * 3600_000).toISOString(),
  };
  return {
    id: 0,
    type: "record",
    action: "create",
    did: DEV_REVIEWER_DID,
    rev: "dev-seed",
    collection: "com.smellgate.review",
    rkey,
    record,
    cid: fakeCid(`review-${idx}`),
    live: true,
  };
}

async function main(): Promise<void> {
  const raw = readFileSync(SEED_PATH, "utf-8");
  const parsed = JSON.parse(raw) as SeedEntry[];
  console.log(`[seed-cache] loaded ${parsed.length} seed entries`);

  // Dynamic imports — see top-of-file note. Must happen AFTER the env
  // var above is set so `lib/curators` parses with the dev curator.
  const { getDb } = await import("../lib/db");
  const { dispatchSmellgateEvent } = await import("../lib/tap/smellgate");

  const db = getDb();

  let perfumeCount = 0;
  const seededPerfumes: Array<{ uri: string; cid: string }> = [];
  for (const entry of parsed) {
    const seedId = entry._seed?.id ?? entry.name;
    const evt = buildPerfumeEvent(entry, seedId);
    await dispatchSmellgateEvent(db, evt);
    const uri = `at://${evt.did}/${evt.collection}/${evt.rkey}`;
    seededPerfumes.push({ uri, cid: evt.cid! });
    perfumeCount += 1;
  }
  console.log(`[seed-cache] dispatched ${perfumeCount} perfume records`);

  // Seed 6 reviews against the first 6 perfumes.
  let reviewCount = 0;
  for (let i = 0; i < Math.min(6, seededPerfumes.length); i++) {
    const p = seededPerfumes[i];
    const evt = buildReviewEvent(p.uri, p.cid, i);
    await dispatchSmellgateEvent(db, evt);
    reviewCount += 1;
  }
  console.log(`[seed-cache] dispatched ${reviewCount} review records`);
  console.log(`[seed-cache] done. curator DID: ${DEV_CURATOR_DID}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
