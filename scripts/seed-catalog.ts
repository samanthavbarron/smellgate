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

  const curatorDid = process.env.SMELLGATE_CURATOR_DID
  if (!curatorDid) {
    throw new Error(
      'SMELLGATE_CURATOR_DID must be set for live seeding. Refusing to run.',
    )
  }

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

  // Typed loosely on purpose — the @atproto/oauth-client-node OAuthSession
  // exposes a protocol-level `.rpc.call(...)` / agent interface which we
  // only need to hit com.atproto.repo.{listRecords,putRecord}.
  const agent = (session as unknown as { agent?: unknown }).agent ?? session

  const call = async (
    method: string,
    params: Record<string, unknown>,
    body?: Record<string, unknown>,
  ): Promise<unknown> => {
    const a = agent as {
      call?: (
        m: string,
        p: Record<string, unknown>,
        b?: Record<string, unknown>,
      ) => Promise<unknown>
      api?: unknown
    }
    if (typeof a.call === 'function') {
      return a.call(method, params, body)
    }
    throw new Error(
      `OAuth session agent does not expose a .call(method, params, body) interface; ` +
        `seeder cannot write records. Inspect @atproto/oauth-client-node API and update this script.`,
    )
  }

  // Fetch existing com.smellgate.perfume records once so we can dedupe by
  // name+house. Paginated.
  const existing = new Set<string>()
  {
    let cursor: string | undefined = undefined
    do {
      const res = (await call('com.atproto.repo.listRecords', {
        repo: curatorDid,
        collection: 'com.smellgate.perfume',
        limit: 100,
        cursor,
      })) as {
        records?: Array<{ value?: { name?: string; house?: string } }>
        cursor?: string
      }
      for (const r of res.records ?? []) {
        const v = r.value
        if (v && typeof v.name === 'string' && typeof v.house === 'string') {
          existing.add(`${v.house}::${v.name}`)
        }
      }
      cursor = res.cursor
    } while (cursor)
  }
  console.log(`found ${existing.size} existing perfume records on curator PDS`)

  let written = 0
  let skipped = 0
  for (const [i, record] of records.entries()) {
    const key = `${String(record.house)}::${String(record.name)}`
    if (existing.has(key)) {
      skipped += 1
      continue
    }
    await call(
      'com.atproto.repo.createRecord',
      {},
      {
        repo: curatorDid,
        collection: 'com.smellgate.perfume',
        record,
      },
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
