import { describe, expect, it } from 'vitest'
import { $safeParse } from '../../../lib/lexicons/app/smellgate/review'
import { loadFixturesForRecord } from './_helpers'

const { valid, invalid } = loadFixturesForRecord('review')

describe('app.smellgate.review validator', () => {
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

  // Programmatic boundary assertions for the numeric + body bounds that
  // issues #192 and #193 flagged as unenforced on bsky.social. The lexicon
  // declares these bounds correctly — the generated $safeParse rejects the
  // bug-reported values at the dispatcher. bsky.social's PDS does not
  // validate third-party lexicons (note the `validationStatus: "unknown"`
  // in issue #192's curl output), so enforcement lives in our dispatcher
  // and write-layer guards, not in the PDS. These tests pin the lexicon
  // contract so the dispatcher stays the enforcement seam.
  describe('rating / sillage / longevity / body bounds (#192, #193)', () => {
    const build = (overrides: Record<string, unknown>) => ({
      $type: 'app.smellgate.review',
      perfume: {
        uri: 'at://did:plc:fixturecuratorxxxxxxxxxx/app.smellgate.perfume/3kxyz222bbb',
        cid: 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
      },
      rating: 5,
      sillage: 3,
      longevity: 3,
      body: 'Reasonable review body.',
      createdAt: '2024-02-12T14:00:00.000Z',
      ...overrides,
    })

    it('accepts rating = 1 and rating = 10 (inclusive bounds)', () => {
      expect($safeParse(build({ rating: 1 })).success).toBe(true)
      expect($safeParse(build({ rating: 10 })).success).toBe(true)
    })

    it('rejects rating = 0, 11, -1, 99 (#192 repros)', () => {
      expect($safeParse(build({ rating: 0 })).success).toBe(false)
      expect($safeParse(build({ rating: 11 })).success).toBe(false)
      expect($safeParse(build({ rating: -1 })).success).toBe(false)
      expect($safeParse(build({ rating: 99 })).success).toBe(false)
    })

    it('accepts sillage = 1 and sillage = 5 (inclusive bounds)', () => {
      expect($safeParse(build({ sillage: 1 })).success).toBe(true)
      expect($safeParse(build({ sillage: 5 })).success).toBe(true)
    })

    it('rejects sillage = 0 and sillage = 6 (#192 repros)', () => {
      expect($safeParse(build({ sillage: 0 })).success).toBe(false)
      expect($safeParse(build({ sillage: 6 })).success).toBe(false)
    })

    it('accepts longevity = 1 and longevity = 5 (inclusive bounds)', () => {
      expect($safeParse(build({ longevity: 1 })).success).toBe(true)
      expect($safeParse(build({ longevity: 5 })).success).toBe(true)
    })

    it('rejects longevity = 0 and longevity = 99 (#192 repros)', () => {
      expect($safeParse(build({ longevity: 0 })).success).toBe(false)
      expect($safeParse(build({ longevity: 99 })).success).toBe(false)
    })

    it('accepts body at exactly 15000 graphemes (inclusive upper bound)', () => {
      expect($safeParse(build({ body: 'x'.repeat(15000) })).success).toBe(true)
    })

    it('rejects body at 15001 graphemes and 16000 (#193 repro)', () => {
      expect($safeParse(build({ body: 'x'.repeat(15001) })).success).toBe(false)
      expect($safeParse(build({ body: 'x'.repeat(16000) })).success).toBe(false)
    })

    it('rejects empty body (minLength: 1, #193 repro)', () => {
      expect($safeParse(build({ body: '' })).success).toBe(false)
    })
  })
})
