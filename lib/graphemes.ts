/**
 * Grapheme counting helper, shared by server actions (#58) and client
 * composers (#83).
 *
 * Why grapheme count and not `string.length`:
 *   `string.length` returns UTF-16 code-unit count, which disagrees
 *   with `maxGraphemes` in the lexicons for any string containing
 *   emoji, surrogate pairs, or combining marks. Example:
 *   `"🏳️‍🌈"` is 1 grapheme but 8 code units. Validating with `.length`
 *   gives the user a misleading count and lets the lexicon's
 *   `$safeParse` reject what the server action accepted.
 *
 * Why `Intl.Segmenter` and not the `graphemer` library:
 *   `Intl.Segmenter` is built into Node 18+ and every modern
 *   browser. No new dependency, no bundler footprint.
 *
 * This module is environment-neutral: it has no Node- or DOM-only
 * imports, so it can be imported from both server actions and client
 * components.
 */

const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Count user-perceived characters (graphemes) in `s`. Matches the
 * semantics of the lexicon `maxGraphemes` constraint.
 *
 * Falls back to `s.length` only if `Intl.Segmenter` is somehow
 * unavailable in the runtime — Node 18+ and all current browsers ship
 * it, so the fallback is defensive only.
 */
export function countGraphemes(s: string): number {
  if (segmenter === null) return s.length;
  let n = 0;
  // Iterating the segmenter and counting is O(n) and allocation-free
  // beyond the segmenter's own state. We don't need the segments
  // themselves, just the count.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of segmenter.segment(s)) n++;
  return n;
}
