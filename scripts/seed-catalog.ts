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
 * Each seed entry has a stable `_seed.id` (e.g. `seed-042`). Before
 * writing, the script fetches the curator's existing
 * `com.smellgate.perfume` records and tries to match by the
 * `name` + `house` pair (the lexicon has no dedicated external-id
 * field, and the `tid` rkey is not stable across runs). If a match
 * is found the entry is skipped.
 *
 * Matching by name+house is approximate — if the curator later
 * writes a real perfume with a colliding name+house the seeder
 * would skip the corresponding seed. Document this limitation
 * rather than fix it: real usage will only run this script once,
 * against a freshly created curator account.
 *
 * ## Usage
 *
 *   pnpm seed:catalog:dry-run        # safe, no network
 *   pnpm seed:catalog                # live, DO NOT RUN until curator is ready
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AtIdentifierString } from '@atproto/lex'
import type { Main as PerfumeMain } from '../lib/lexicons/com/smellgate/perfume.defs'

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
  const records = entries.map(stripSeedMeta)
  console.log(`loaded ${entries.length} seed entries`)
  summarizeCatalog(records)
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
  const records = entries.map(stripSeedMeta)
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

  // Fetch existing com.smellgate.perfume records once so we can dedupe by
  // name+house. Paginated.
  const existing = new Set<string>()
  let cursor: string | undefined = undefined
  for (;;) {
    const page: Awaited<
      ReturnType<typeof lexClient.list<typeof com.smellgate.perfume.main>>
    > = await lexClient.list(com.smellgate.perfume.main, {
      repo,
      limit: 100,
      cursor,
    })
    for (const r of page.records ?? []) {
      const v = r.value as { name?: unknown; house?: unknown }
      if (v && typeof v.name === 'string' && typeof v.house === 'string') {
        existing.add(`${v.house}::${v.name}`)
      }
    }
    if (!page.cursor) break
    cursor = page.cursor
  }
  console.log(`found ${existing.size} existing perfume records on curator PDS`)

  // The typed `create` helper takes `Omit<Infer<T>, '$type'>` and
  // re-attaches the `$type` itself. Seed entries already carry
  // `$type: "com.smellgate.perfume"` from the fixture so we strip it
  // here before handing the body off.
  type PerfumeInput = Omit<PerfumeMain, '$type'>

  let written = 0
  let skipped = 0
  for (const [i, raw] of records.entries()) {
    const key = `${String(raw.house)}::${String(raw.name)}`
    if (existing.has(key)) {
      skipped += 1
      continue
    }
    const { $type: _drop, ...input } = raw as Record<string, unknown>
    void _drop
    await lexClient.create(
      com.smellgate.perfume.main,
      input as unknown as PerfumeInput,
      { repo },
    )
    written += 1
    if ((i + 1) % 10 === 0) {
      console.log(`  progress: ${i + 1}/${records.length}`)
    }
  }

  console.log(`done. wrote ${written} records, skipped ${skipped} duplicates.`)
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2))
  if (dryRun) {
    await runDryRun()
    return
  }
  await runLive()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
