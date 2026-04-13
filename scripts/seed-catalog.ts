#!/usr/bin/env tsx
/**
 * scripts/seed-catalog.ts
 *
 * One-shot seeder that publishes the synthetic catalog from
 * `tests/fixtures/seed-catalog.json` into a curator PDS as
 * `com.smellgate.perfume` records.
 *
 * ============================================================
 * DO NOT RUN AGAINST A REAL PDS UNTIL THE CURATOR ACCOUNT IS
 * READY AND A HUMAN HAS EXPLICITLY AUTHORIZED THE WRITE.
 * ============================================================
 *
 * This script exists so that, when the curator account is set up,
 * populating its PDS is a single command. Until then, only the
 * `--dry-run` mode is safe to run: it parses the catalog, strips
 * the `_seed` meta-field, builds the records it *would* write, and
 * prints a summary. Dry-run mode makes **no network calls**.
 *
 * ## Authentication
 *
 * The live (non dry-run) mode reuses the production OAuth client
 * setup from `lib/auth/client.ts`. It does NOT perform an
 * interactive OAuth flow from the CLI — it expects that the curator
 * account has already completed an OAuth authorization through the
 * normal web flow, so a saved session exists in the app's session
 * store. The seeder then calls `oauthClient.restore(curatorDid)`
 * to get an authenticated session and uses it to write records.
 *
 * If no saved session exists for the curator DID, the seeder
 * aborts with a clear error. Bootstrapping the initial session is
 * a manual step and is out of scope for this script.
 *
 * ## Environment variables
 *
 * Live mode:
 *   SMELLGATE_CURATOR_DID       required — did:plc:... of the curator account
 *   SMELLGATE_CURATOR_PDS_URL   optional — PDS base URL, only used for logging
 *   PUBLIC_URL, PRIVATE_KEY     as in lib/auth/client.ts (production OAuth client)
 *
 * Dry-run mode needs none of these.
 *
 * ## Idempotency
 *
 * Each seed entry has a stable `_seed.id` (e.g. `seed-042`). The
 * seeder hashes that id into a deterministic, TID-shaped rkey
 * (`seedRkey`, below) and uses the lex-client `put` entrypoint,
 * which is create-or-update at a specific rkey. Running the script
 * twice writes the same rkey twice with identical content and the
 * second run is a no-op upsert; running with an edited fixture
 * updates the existing record in place. No pre-flight `list` / no
 * name+house fuzzy match.
 *
 * The lexicon (`lexicons/com/smellgate/perfume.json`) specifies
 * `record.key: "tid"`, so the rkey must conform to the TID shape
 * (13 characters, base32-sortable, with the first character drawn
 * from the low-16 subset per `@atproto/syntax`'s `isValidTid`).
 * `seedRkey` builds one by SHA-256'ing the seed id and encoding 13
 * digits out of the digest — deterministic, collision-free across
 * the 75-entry fixture, and accepted by `com.atproto.repo.putRecord`
 * exactly the same way a server-minted TID is.
 *
 * ## Usage
 *
 *   pnpm seed:catalog:dry-run        # safe, no network
 *   pnpm seed:catalog                # live, DO NOT RUN until curator is ready
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AtIdentifierString } from '@atproto/lex'
import type { Main as PerfumeMain } from '../lib/lexicons/com/smellgate/perfume.defs'

// Base32-sortable alphabet, as used by `@atproto/common-web` for TIDs.
// 32 characters; order is preserved when strings are compared
// byte-wise, so rkeys built from this alphabet still sort cleanly.
const S32_CHAR = '234567abcdefghijklmnopqrstuvwxyz'
const TID_LEN = 13

/**
 * Deterministic, TID-shaped rkey for a seed entry. Hashes the seed
 * id with SHA-256, then walks the digest five bits at a time into
 * characters of the `234567abcdefghijklmnopqrstuvwxyz`
 * base32-sortable alphabet used by `@atproto/common-web` for TIDs.
 *
 * CRITICAL — TID format (see `@atproto/syntax/dist/tid.js`):
 *   /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/
 * The FIRST character must come from the low-16 subset of the
 * alphabet. Real TIDs satisfy this because the 53-bit timestamp is
 * stored in the top bits of a ≤64-bit value whose leading bit is
 * always 0. `isValidTid` enforces the constraint and a PDS's
 * `putRecord` rejects rkeys that fail it.
 *
 * Fix for #41 review: position 0 masks the 5-bit digest index to
 * 4 bits (`& 0b01111`) so it can only land in the low-16 subset.
 * Positions 1-12 keep the full 5-bit range. This trades one bit of
 * entropy at position 0 for strict TID conformance — still 64 total
 * bits of hash-derived entropy, far more than needed for
 * collision-freedom across the 75-entry fixture (verified by the
 * `seedRkey` test).
 *
 * Stable across runs because the hash is pure.
 */
export function seedRkey(seedId: string): string {
  const digest = createHash('sha256').update(seedId).digest()
  let rkey = ''
  let bitBuf = 0
  let bitCount = 0
  let byteIdx = 0
  while (rkey.length < TID_LEN) {
    while (bitCount < 5) {
      if (byteIdx >= digest.length) {
        throw new Error(`seedRkey: digest exhausted for ${seedId}`)
      }
      bitBuf = (bitBuf << 8) | digest[byteIdx]
      byteIdx += 1
      bitCount += 8
    }
    // Position 0 must come from the low-16 subset so the result
    // passes `@atproto/syntax`'s `isValidTid` check. All other
    // positions use the full 5-bit range.
    const mask = rkey.length === 0 ? 0b01111 : 0b11111
    const idx = (bitBuf >> (bitCount - 5)) & mask
    bitCount -= 5
    rkey += S32_CHAR[idx]
  }
  return rkey
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SEED_CATALOG_PATH = join(
  __dirname,
  '..',
  'tests',
  'fixtures',
  'seed-catalog.json',
)

type SeedMeta = { synthetic: boolean; id: string }
type SeedEntry = Record<string, unknown> & { _seed: SeedMeta }
type PerfumeRecord = Record<string, unknown>

function loadCatalog(): SeedEntry[] {
  const raw = readFileSync(SEED_CATALOG_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`${SEED_CATALOG_PATH} must be a JSON array`)
  }
  return parsed as SeedEntry[]
}

function stripSeedMeta(entry: SeedEntry): PerfumeRecord {
  const { _seed: _discard, ...rest } = entry
  void _discard
  return rest
}

interface SeedPair {
  record: PerfumeRecord
  rkey: string
  seedId: string
}

function buildSeedPairs(entries: SeedEntry[]): SeedPair[] {
  const seen = new Set<string>()
  const out: SeedPair[] = []
  for (const entry of entries) {
    const seedId = entry._seed?.id
    if (typeof seedId !== 'string' || seedId.length === 0) {
      throw new Error(
        `seed entry missing required _seed.id: ${JSON.stringify(entry).slice(0, 120)}`,
      )
    }
    if (seen.has(seedId)) {
      throw new Error(`duplicate _seed.id in catalog: ${seedId}`)
    }
    seen.add(seedId)
    out.push({
      record: stripSeedMeta(entry),
      rkey: seedRkey(seedId),
      seedId,
    })
  }
  return out
}

function parseArgs(argv: string[]): { dryRun: boolean } {
  const dryRun = argv.includes('--dry-run')
  return { dryRun }
}

function summarizeCatalog(records: PerfumeRecord[]): void {
  const houses = new Set<string>()
  const years: number[] = []
  for (const r of records) {
    if (typeof r.house === 'string') houses.add(r.house)
    if (typeof r.releaseYear === 'number') years.push(r.releaseYear)
  }
  console.log(`  entries:       ${records.length}`)
  console.log(`  houses:        ${houses.size}`)
  if (years.length) {
    console.log(
      `  release years: ${Math.min(...years)} - ${Math.max(...years)} (${years.length} with year)`,
    )
  }
  console.log('  sample:')
  for (const r of records.slice(0, 5)) {
    console.log(`    - ${String(r.name)} (${String(r.house)})`)
  }
}

async function runDryRun(): Promise<void> {
  console.log('seed-catalog: DRY RUN (no network calls)')
  console.log(`reading ${SEED_CATALOG_PATH}`)
  const entries = loadCatalog()
  const pairs = buildSeedPairs(entries)
  console.log(`loaded ${entries.length} seed entries`)
  summarizeCatalog(pairs.map((p) => p.record))
  console.log('  deterministic rkeys (first 5):')
  for (const p of pairs.slice(0, 5)) {
    console.log(`    - ${p.seedId} -> ${p.rkey}`)
  }
  console.log('dry run complete. no records were written.')
}

async function runLive(): Promise<void> {
  // All imports that touch OAuth / the session DB are lazy so `--dry-run`
  // doesn't spin up a SQLite connection or pull in Next-adjacent modules.
  const { getOAuthClient } = await import('../lib/auth/client')
  const { Client } = await import('@atproto/lex')
  const com = await import('../lib/lexicons/com')

  const curatorDid = process.env.SMELLGATE_CURATOR_DID
  if (!curatorDid) {
    throw new Error(
      'SMELLGATE_CURATOR_DID must be set for live seeding. Refusing to run.',
    )
  }
  const repo = curatorDid as unknown as AtIdentifierString

  console.log('seed-catalog: LIVE MODE')
  console.log(`curator did:   ${curatorDid}`)
  if (process.env.SMELLGATE_CURATOR_PDS_URL) {
    console.log(`curator pds:   ${process.env.SMELLGATE_CURATOR_PDS_URL}`)
  }

  const entries = loadCatalog()
  const pairs = buildSeedPairs(entries)
  console.log(`loaded ${entries.length} seed entries`)

  const oauthClient = await getOAuthClient()
  let session: Awaited<ReturnType<typeof oauthClient.restore>>
  try {
    session = await oauthClient.restore(curatorDid)
  } catch (err) {
    throw new Error(
      `failed to restore OAuth session for ${curatorDid}: ${(err as Error).message}\n` +
        'The curator account must complete an OAuth authorization through the web flow before this script can run.',
    )
  }

  // Use the same `@atproto/lex` `Client` wrapper that
  // `lib/server/smellgate-actions.ts` uses to write records via an
  // OAuth session. The Client constructor accepts an `OAuthSession`
  // directly and exposes typed `create` / `list` entrypoints keyed on
  // the generated lexicon record schema, going through the session's
  // DPoP-bound fetch.
  const lexClient = new Client(session)

  // Idempotency lives in the rkey (#41): we `put` at a deterministic
  // TID-shaped rkey derived from `_seed.id`. Re-running the seeder
  // with the same fixture is a no-op upsert; re-running with an
  // edited fixture rewrites in place. No pre-flight list, no
  // name+house fuzzy match.

  // The typed `put` helper takes `Omit<Infer<T>, '$type'>` and
  // re-attaches the `$type` itself. Seed entries already carry
  // `$type: "com.smellgate.perfume"` from the fixture so we strip it
  // here before handing the body off.
  type PerfumeInput = Omit<PerfumeMain, '$type'>

  let written = 0
  for (const [i, pair] of pairs.entries()) {
    const { $type: _drop, ...input } = pair.record as Record<string, unknown>
    void _drop
    await lexClient.put(
      com.smellgate.perfume.main,
      input as unknown as PerfumeInput,
      { repo, rkey: pair.rkey },
    )
    written += 1
    if ((i + 1) % 10 === 0) {
      console.log(`  progress: ${i + 1}/${pairs.length}`)
    }
  }

  console.log(`done. upserted ${written} records (idempotent by _seed.id rkey).`)
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2))
  if (dryRun) {
    await runDryRun()
    return
  }
  await runLive()
}

// Only run `main()` when invoked directly (`tsx scripts/seed-catalog.ts`).
// Importing this module from a unit test for the `seedRkey` helper must
// not trigger OAuth / PDS calls. `process.argv[1]` on a direct tsx
// invocation is the resolved path of this file; when imported from a
// vitest test it's the vitest runner instead.
const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      fileURLToPath(import.meta.url) === process.argv[1]
    )
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
