import { describe, expect, it } from 'vitest'
import { $safeParse } from '../../../lib/lexicons/app/smellgate/perfume'
import { loadFixturesForRecord } from './_helpers'

const { valid, invalid } = loadFixturesForRecord('perfume')

describe('app.smellgate.perfume validator', () => {
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

  // Programmatic boundary assertions for notes + description bounds (#174,
  // applied to perfume.json for symmetry with perfumeSubmission.json).
  describe('notes + description bounds (#174)', () => {
    const build = (overrides: Record<string, unknown>) => ({
      $type: 'app.smellgate.perfume',
      name: 'Bounded',
      house: 'Bounded House',
      notes: ['rose'],
      createdAt: '2024-01-15T12:34:56.000Z',
      ...overrides,
    })

    it('accepts an array of exactly 50 notes (inclusive upper bound)', () => {
      const notes = Array.from({ length: 50 }, (_, i) => `note${i}`)
      expect($safeParse(build({ notes })).success).toBe(true)
    })

    it('rejects an array of 51 notes (just past the upper bound)', () => {
      const notes = Array.from({ length: 51 }, (_, i) => `note${i}`)
      expect($safeParse(build({ notes })).success).toBe(false)
    })

    it('accepts a note item of exactly 100 graphemes (inclusive)', () => {
      expect($safeParse(build({ notes: ['a'.repeat(100)] })).success).toBe(true)
    })

    it('rejects a note item of 101 graphemes', () => {
      expect($safeParse(build({ notes: ['a'.repeat(101)] })).success).toBe(false)
    })

    it('accepts description of exactly 15000 graphemes (inclusive)', () => {
      expect(
        $safeParse(build({ description: 'd'.repeat(15000) })).success,
      ).toBe(true)
    })

    it('rejects description of 15001 graphemes', () => {
      expect(
        $safeParse(build({ description: 'd'.repeat(15001) })).success,
      ).toBe(false)
    })
  })
})
