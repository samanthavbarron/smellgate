/**
 * Fragrance palette generation (issue #217, Phase 2).
 *
 * A "palette" is a short ordered list of swatches derived from a
 * fragrance's notes. The issue gives the high-level recipe; this
 * module is a pragmatic v0 of it.
 *
 * Input: a list of note strings. We don't yet carry pyramid-position
 * metadata (`lexicons/app/smellgate/perfume.json` stores notes as a
 * flat array — per docs/lexicons.md: "The tag namespace is
 * deliberately flat; we don't split into top/heart/base in v1"). So
 * the "weight by pyramid position" step the issue describes is
 * deferred until the lexicon grows. For now every note carries equal
 * weight and the selection algorithm picks the N notes whose swatches
 * give the most lightness coverage.
 *
 * Output: 3–5 swatches ordered light-to-dark. Rendered as a gradient
 * this doubles as a pyramid stand-in (lighter notes on top fade to
 * heavier notes on the base).
 *
 * The algorithm is deterministic so palette tiles render the same on
 * server and client, and so tests can assert specific outputs.
 */

import { swatchCssBg, swatchFor, type Swatch } from "./swatches";

export type { Swatch } from "./swatches";
export { swatchCssBg, swatchCssFg, swatchFor } from "./swatches";

export interface Palette {
  /** The original notes that ended up represented in the palette, same order as `stops`. */
  notes: string[];
  /** The swatches, ordered light-to-dark. Length 3–5. */
  stops: Swatch[];
}

/**
 * Build a palette from a notes array. Pure, deterministic, cheap —
 * called at render time for every tile.
 *
 * Steps:
 *
 * 1. Resolve each note to a swatch.
 * 2. Dedupe swatches that are visually near-identical (same HSL
 *    bucket) so a fragrance listing both "musk" and "white musk"
 *    doesn't end up with two adjacent beige blobs.
 * 3. Sort by lightness ascending — gradients read better when
 *    they sweep low-to-high luminance with no backtracking.
 * 4. Trim to 3–5 stops, favouring lightness-coverage: we bias the
 *    selection toward both the lightest and the darkest retained
 *    swatches so a 12-note fragrance doesn't reduce to three
 *    mid-tones.
 * 5. Reverse to light-to-dark (the rendered gradient goes top to
 *    bottom = light to dark = top-notes → base-notes metaphor).
 *
 * An empty-notes input produces a single-stop neutral palette so a
 * fragrance-tile consumer always has something to render.
 */
export function paletteForNotes(
  rawNotes: readonly string[],
  opts: { minStops?: number; maxStops?: number } = {},
): Palette {
  const minStops = opts.minStops ?? 3;
  const maxStops = opts.maxStops ?? 5;
  if (rawNotes.length === 0) {
    return {
      notes: [],
      stops: [neutralSwatch()],
    };
  }

  // 1 & 2: resolve + dedupe by visual bucket.
  const bucketed = new Map<string, { note: string; sw: Swatch }>();
  for (const note of rawNotes) {
    const sw = swatchFor(note);
    const key = bucketKey(sw);
    if (!bucketed.has(key)) bucketed.set(key, { note, sw });
  }
  const unique = Array.from(bucketed.values());

  // 3: sort low-to-high lightness for the selection step.
  unique.sort((a, b) => a.sw.bg.l - b.sw.bg.l);

  // 4: pick stops. If we already have ≤ maxStops after dedupe,
  // everything's in. Otherwise we anchor on the lightest and darkest
  // and fill the middle by even lightness-stride so the palette spans
  // the full range rather than clustering.
  const picked =
    unique.length <= maxStops
      ? unique
      : spanSelect(unique, maxStops);

  // 5: if a minimalist fragrance only produced 1-2 stops, pad with
  // tonal variants so the gradient has something to interpolate.
  const padded = padToMin(picked, minStops);

  // 6: light-to-dark for the rendered gradient (top of fragrance →
  // base, following the pyramid metaphor).
  padded.sort((a, b) => b.sw.bg.l - a.sw.bg.l);

  return {
    notes: padded.map((p) => p.note),
    stops: padded.map((p) => p.sw),
  };
}

/**
 * Render a palette as a CSS `linear-gradient(...)` string. Top
 * (lightest) to bottom (darkest). Suitable for `background:` on a
 * tile or a header.
 */
export function paletteGradientCss(
  p: Palette,
  direction: string = "to bottom",
): string {
  if (p.stops.length === 0) return "transparent";
  const stops = p.stops
    .map(
      (s, i) =>
        `${swatchCssBg(s)} ${((i / Math.max(1, p.stops.length - 1)) * 100).toFixed(1)}%`,
    )
    .join(", ");
  return `linear-gradient(${direction}, ${stops})`;
}

function neutralSwatch(): Swatch {
  return {
    bg: { h: 35, s: 8, l: 72 },
    fg: { h: 35, s: 10, l: 22 },
  };
}

/**
 * Visual-bucket key: the swatch's HSL rounded to a coarse grid. Two
 * swatches that share a key are close enough that including both would
 * look like a duplicate stop.
 */
function bucketKey(s: Swatch): string {
  const h = Math.round(s.bg.h / 20) * 20;
  const l = Math.round(s.bg.l / 10) * 10;
  return `${h}:${l}`;
}

/**
 * Pick `n` items spanning the lightness range: always include the
 * endpoints, then space the remaining picks at roughly equal
 * lightness intervals. Input must be sorted by lightness ascending.
 */
function spanSelect<T extends { sw: Swatch }>(sorted: T[], n: number): T[] {
  if (sorted.length <= n) return sorted.slice();
  const out: T[] = [sorted[0]];
  const step = (sorted.length - 1) / (n - 1);
  for (let i = 1; i < n - 1; i += 1) {
    const idx = Math.round(i * step);
    const candidate = sorted[idx];
    if (candidate && !out.includes(candidate)) out.push(candidate);
  }
  out.push(sorted[sorted.length - 1]);
  // Dedup collisions from the rounding step.
  const seen = new Set<T>();
  return out.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

/**
 * If the palette came out below `min` stops (minimalist fragrance or
 * aggressive dedupe), pad with tonal variants (lighter/darker twins)
 * of whatever we have. This keeps the gradient readable without
 * inventing unrelated colors.
 */
function padToMin(
  items: { note: string; sw: Swatch }[],
  min: number,
): { note: string; sw: Swatch }[] {
  if (items.length >= min) return items.slice();
  if (items.length === 0) {
    return [{ note: "", sw: neutralSwatch() }];
  }
  const out: { note: string; sw: Swatch }[] = items.slice();
  // Make lighter + darker tonal twins of the first stop until we hit
  // the minimum. This preserves the visual character of the single
  // real swatch.
  const base = items[0].sw.bg;
  let delta = 1;
  while (out.length < min) {
    const lighter: Swatch = {
      bg: { h: base.h, s: base.s, l: clamp(base.l + delta * 12, 12, 92) },
      fg: { ...items[0].sw.fg },
    };
    if (out.length < min) out.push({ note: items[0].note, sw: lighter });
    const darker: Swatch = {
      bg: { h: base.h, s: base.s, l: clamp(base.l - delta * 12, 12, 92) },
      fg: { ...items[0].sw.fg },
    };
    if (out.length < min) out.push({ note: items[0].note, sw: darker });
    delta += 1;
    if (delta > 5) break; // safety
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
