import { describe, expect, it } from 'vitest'
import { $safeParse } from '../../../lib/lexicons/app/smellgate/comment'
import { loadFixturesForRecord } from './_helpers'

const { valid, invalid } = loadFixturesForRecord('comment')

describe('app.smellgate.comment validator', () => {
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

  // Programmatic boundary assertions for comment.body (#196). Like #192 /
  // #193, the lexicon declares minLength: 1 / maxGraphemes: 5000 — bsky.social
  // doesn't enforce third-party lexicons, so the dispatcher's $safeParse is
  // the enforcement seam. These tests pin that contract.
  describe('body bounds (#196)', () => {
    const build = (body: unknown) => ({
      $type: 'app.smellgate.comment',
      subject: {
        uri: 'at://did:plc:fixtureusersxxxxxxxxxxxxx/app.smellgate.review/3kxyz444ddd',
        cid: 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
      },
      body,
      createdAt: '2024-02-15T13:00:00.000Z',
    })

    it('accepts body at exactly 5000 graphemes (inclusive upper bound)', () => {
      expect($safeParse(build('c'.repeat(5000))).success).toBe(true)
    })

    it('rejects body at 5001 and 6000 graphemes (#196 repro)', () => {
      expect($safeParse(build('c'.repeat(5001))).success).toBe(false)
      expect($safeParse(build('c'.repeat(6000))).success).toBe(false)
    })

    it('rejects empty body (minLength: 1, #196 repro)', () => {
      expect($safeParse(build('')).success).toBe(false)
    })
  })
})
