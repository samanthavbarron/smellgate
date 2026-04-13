/**
 * Unit tests for `lib/graphemes.ts`.
 *
 * The whole point of `countGraphemes` is to disagree with
 * `string.length` on strings that contain emoji, surrogate pairs, or
 * combining marks — those are exactly the cases the lexicon
 * `maxGraphemes` constraint cares about, and the cases #58 and #83
 * were filed to fix. The tests below pick fixtures where
 * `string.length !== countGraphemes(s)` so a regression to
 * `s.length` would break them.
 */

import { describe, expect, it } from 'vitest'
import { countGraphemes } from '../../lib/graphemes'

describe('countGraphemes', () => {
  it('counts plain ASCII as one grapheme per char', () => {
    expect(countGraphemes('')).toBe(0)
    expect(countGraphemes('hello')).toBe(5)
    expect(countGraphemes('a b c')).toBe(5)
  })

  it('counts a basic BMP emoji as one grapheme even though .length is 2', () => {
    // U+1F33A SUNFLOWER, surrogate pair in UTF-16
    const s = '🌺'
    expect(s.length).toBe(2)
    expect(countGraphemes(s)).toBe(1)
  })

  it('counts a ZWJ sequence (rainbow flag) as one grapheme', () => {
    // U+1F3F3 U+FE0F U+200D U+1F308 — 4 codepoints, 6 UTF-16 units
    const s = '🏳️‍🌈'
    expect(s.length).toBeGreaterThan(1)
    expect(countGraphemes(s)).toBe(1)
  })

  it('counts a combining-mark character as one grapheme', () => {
    // 'e' + U+0301 COMBINING ACUTE ACCENT
    const s = 'e\u0301'
    expect(s.length).toBe(2)
    expect(countGraphemes(s)).toBe(1)
  })

  it('counts a mixed string correctly', () => {
    const s = 'hi 🌺!'
    // h, i, ' ', 🌺, ! = 5 graphemes
    expect(countGraphemes(s)).toBe(5)
    // .length would be 6 because 🌺 is two UTF-16 units
    expect(s.length).toBe(6)
  })

  it('a string of N emoji has length 2N but N graphemes (boundary check)', () => {
    const s = '🌺'.repeat(10)
    expect(s.length).toBe(20)
    expect(countGraphemes(s)).toBe(10)
  })

  it('a 5-grapheme emoji string passes a maxGraphemes=5 check that would fail under .length', () => {
    // Simulates the validator we use in the server actions: count
    // graphemes against a max, not code units. This is the
    // load-bearing case from #58.
    const max = 5
    const s = '🌺🌺🌺🌺🌺' // 5 graphemes, 10 code units
    expect(countGraphemes(s) <= max).toBe(true)
    expect(s.length <= max).toBe(false)
  })

  it('a 6-grapheme string fails maxGraphemes=5 (inverse case)', () => {
    const max = 5
    const s = '🌺🌺🌺🌺🌺🌺'
    expect(countGraphemes(s) <= max).toBe(false)
  })
})
