import { describe, expect, it } from 'vitest'
import { $safeParse } from '../../../lib/lexicons/com/smellgate/perfumeSubmissionResolution'
import { loadFixturesForRecord } from './_helpers'

const { valid, invalid } = loadFixturesForRecord('perfumeSubmissionResolution')

describe('com.smellgate.perfumeSubmissionResolution validator', () => {
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
})
