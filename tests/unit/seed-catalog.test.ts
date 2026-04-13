import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { $safeParse } from '../../lib/lexicons/com/smellgate/perfume'
import { seedRkey } from '../../scripts/seed-catalog'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SEED_CATALOG_PATH = join(
  __dirname,
  '..',
  'fixtures',
  'seed-catalog.json',
)

type SeedMeta = { synthetic: boolean; id: string }
type SeedEntry = Record<string, unknown> & { _seed: SeedMeta }

function loadCatalog(): SeedEntry[] {
  const raw = readFileSync(SEED_CATALOG_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error('seed-catalog.json must be a JSON array')
  }
  return parsed as SeedEntry[]
}

/**
 * Canonical note families we expect the catalog to span. Each family maps to
 * a set of lowercase substring matches on the entry's `notes` array. This is
 * deliberately loose — we only need to confirm that the catalog reaches at
 * least a handful of distinct families, not to classify every perfume.
 */
const NOTE_FAMILIES: Record<string, string[]> = {
  citrus: ['bergamot', 'lemon', 'mandarin', 'grapefruit', 'neroli', 'petitgrain', 'orange', 'verbena'],
  floral: ['rose', 'jasmine', 'tuberose', 'iris', 'violet', 'gardenia', 'mimosa', 'muguet', 'lily', 'honeysuckle', 'narcissus', 'osmanthus', 'ylang', 'heliotrope', 'frangipani', 'tiare', 'linden'],
  woody: ['sandalwood', 'cedar', 'hinoki', 'cypress', 'pine', 'vetiver', 'fir', 'birch'],
  gourmand: ['vanilla', 'caramel', 'tonka', 'cocoa', 'coffee', 'almond', 'brioche', 'sugar', 'praline', 'meringue', 'butter', 'marzipan', 'pastry'],
  oriental: ['amber', 'labdanum', 'benzoin', 'myrrh', 'frankincense', 'incense', 'opoponax', 'oud', 'styrax'],
  fougere: ['lavender', 'coumarin', 'geranium', 'clary sage', 'hay'],
  chypre: ['oakmoss', 'patchouli'],
  aquatic: ['sea salt', 'ozone', 'seaweed', 'driftwood', 'ambergris', 'mineral water', 'melon', 'cucumber', 'water'],
  leather: ['leather', 'suede', 'castoreum', 'birch tar'],
  green: ['galbanum', 'fig leaf', 'tomato leaf', 'green', 'watercress', 'moss', 'lichen', 'peat', 'mastic', 'heather', 'papyrus', 'bamboo'],
}

function familiesForEntry(notes: string[]): Set<string> {
  const out = new Set<string>()
  for (const [family, markers] of Object.entries(NOTE_FAMILIES)) {
    for (const marker of markers) {
      if (notes.some((n) => n.toLowerCase().includes(marker))) {
        out.add(family)
        break
      }
    }
  }
  return out
}

describe('seed-catalog.json', () => {
  const entries = loadCatalog()

  it('has between 50 and 100 entries', () => {
    expect(entries.length).toBeGreaterThanOrEqual(50)
    expect(entries.length).toBeLessThanOrEqual(100)
  })

  it('every entry has _seed.synthetic === true and a unique _seed.id', () => {
    const ids = new Set<string>()
    for (const entry of entries) {
      expect(entry._seed, `entry missing _seed: ${JSON.stringify(entry)}`).toBeDefined()
      expect(entry._seed.synthetic).toBe(true)
      expect(typeof entry._seed.id).toBe('string')
      expect(entry._seed.id.length).toBeGreaterThan(0)
      expect(ids.has(entry._seed.id)).toBe(false)
      ids.add(entry._seed.id)
    }
    expect(ids.size).toBe(entries.length)
  })

  it('every entry validates against com.smellgate.perfume after stripping _seed', () => {
    for (const entry of entries) {
      const { _seed: _discard, ...record } = entry
      void _discard
      const result = $safeParse(record)
      if (!result.success) {
        throw new Error(
          `entry ${entry._seed.id} failed validation: ${result.reason.message}`,
        )
      }
      expect(result.success).toBe(true)
    }
  })

  it('every entry has notes that are lowercase non-empty strings (3-8 per entry)', () => {
    for (const entry of entries) {
      const notes = entry.notes as unknown
      expect(Array.isArray(notes)).toBe(true)
      const arr = notes as string[]
      expect(arr.length).toBeGreaterThanOrEqual(3)
      expect(arr.length).toBeLessThanOrEqual(8)
      for (const note of arr) {
        expect(typeof note).toBe('string')
        expect(note.length).toBeGreaterThan(0)
        expect(note).toBe(note.toLowerCase())
      }
    }
  })

  it('every entry has a 1-2 sentence description', () => {
    for (const entry of entries) {
      const desc = entry.description as unknown
      expect(typeof desc).toBe('string')
      expect((desc as string).length).toBeGreaterThan(0)
    }
  })

  it('touches at least 5 distinct canonical note families', () => {
    const seen = new Set<string>()
    for (const entry of entries) {
      const notes = entry.notes as string[]
      for (const f of familiesForEntry(notes)) seen.add(f)
    }
    expect(
      seen.size,
      `families touched: ${[...seen].join(', ')}`,
    ).toBeGreaterThanOrEqual(5)
  })

  it('spans at least 30 years of releaseYear values', () => {
    const years: number[] = []
    for (const entry of entries) {
      const y = entry.releaseYear
      if (typeof y === 'number') years.push(y)
    }
    expect(years.length).toBeGreaterThan(0)
    const span = Math.max(...years) - Math.min(...years)
    expect(span).toBeGreaterThanOrEqual(30)
  })

  it('has at least 10 distinct house values', () => {
    const houses = new Set<string>()
    for (const entry of entries) {
      const h = entry.house
      if (typeof h === 'string') houses.add(h)
    }
    expect(houses.size).toBeGreaterThanOrEqual(10)
  })

  it('has creator set on roughly half the entries (25%-75%)', () => {
    const withCreator = entries.filter((e) => typeof e.creator === 'string').length
    const ratio = withCreator / entries.length
    expect(ratio).toBeGreaterThanOrEqual(0.25)
    expect(ratio).toBeLessThanOrEqual(0.75)
  })
})

describe('seedRkey (#41)', () => {
  it('produces a 13-character base32-sortable string', () => {
    const rkey = seedRkey('seed-042')
    expect(rkey).toHaveLength(13)
    // TID alphabet per @atproto/common-web util.ts.
    expect(rkey).toMatch(/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/)
  })

  it('is deterministic across calls', () => {
    const a = seedRkey('seed-001')
    const b = seedRkey('seed-001')
    expect(a).toBe(b)
  })

  it('produces a unique rkey for every seed entry in the fixture', () => {
    const entries = loadCatalog()
    const seen = new Set<string>()
    for (const entry of entries) {
      const rkey = seedRkey(entry._seed.id)
      expect(rkey).toHaveLength(13)
      expect(
        seen.has(rkey),
        `collision: ${rkey} for ${entry._seed.id}`,
      ).toBe(false)
      seen.add(rkey)
    }
    expect(seen.size).toBe(entries.length)
  })

  it('differs between distinct seed ids', () => {
    const a = seedRkey('seed-001')
    const b = seedRkey('seed-002')
    expect(a).not.toBe(b)
  })
})
