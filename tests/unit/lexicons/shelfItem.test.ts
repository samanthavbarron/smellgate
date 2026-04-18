import { describe, expect, it } from 'vitest'
import { $safeParse } from '../../../lib/lexicons/app/smellgate/shelfItem'
import { loadFixturesForRecord } from './_helpers'

const { valid, invalid } = loadFixturesForRecord('shelfItem')

describe('app.smellgate.shelfItem validator', () => {
  it('has at least one valid fixture and two invalid fixtures', () => {
    expect(valid.length).toBeGreaterThanOrEqual(1)
    expect(invalid.length).toBeGreaterThanOrEqual(2)
  })

  for (const fixture of valid) {
    it(`accepts ${fixture.name}`, () => {
      const result = $safeParse(fixture.value)
      if (!result.success) {
        throw new Error(
          `expected ${fixture.name} to validate, got: ${result.reason.message}`,
        )
      }
      expect(result.success).toBe(true)
    })
  }

  for (const fixture of invalid) {
    it(`rejects ${fixture.name}`, () => {
      const result = $safeParse(fixture.value)
      expect(result.success).toBe(false)
    })
  }

  // Programmatic boundary assertions for the bottleSizeMl bound (#167).
  // Fixture files cover well-past-bound cases; these pin the exact inclusive
  // edges (1 and 1000) and the just-past-edge cases (0 and 1001) so that a
  // later lexicon loosen/tighten can't silently drift the bound.
  describe('bottleSizeMl bounds (#167)', () => {
    const build = (bottleSizeMl: unknown) => ({
      $type: 'app.smellgate.shelfItem',
      perfume: {
        uri: 'at://did:plc:fixturecuratorxxxxxxxxxx/app.smellgate.perfume/3kxyz222bbb',
        cid: 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
      },
      bottleSizeMl,
      createdAt: '2024-02-10T09:00:00.000Z',
    })

    it('accepts 1 (inclusive lower bound)', () => {
      expect($safeParse(build(1)).success).toBe(true)
    })

    it('accepts 1000 (inclusive upper bound)', () => {
      expect($safeParse(build(1000)).success).toBe(true)
    })

    it('rejects 0 (just below the lower bound)', () => {
      expect($safeParse(build(0)).success).toBe(false)
    })

    it('rejects 1001 (just above the upper bound)', () => {
      expect($safeParse(build(1001)).success).toBe(false)
    })

    it('rejects -50 (the #167 repro)', () => {
      expect($safeParse(build(-50)).success).toBe(false)
    })

    it('rejects 999999 (the other #167 repro)', () => {
      expect($safeParse(build(999999)).success).toBe(false)
    })
  })
})
