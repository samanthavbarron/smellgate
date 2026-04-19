/**
 * Swatch library v0 (issue #217, Phase 1).
 *
 * Maps common perfumery notes to HSL colors. Each swatch has two
 * variants — `bg` (a mid-tone for use on the calm neutral shell) and
 * `fg` (a luminance-appropriate foreground for text on top of `bg`).
 *
 * Design rules for the library (from the issue):
 *
 * - Literal where a note has a strong visual association (lemon →
 *   pale yellow, vetiver → wet moss green, rose → dusty pink).
 * - Synesthetic where it doesn't (iris → cold lavender-gray,
 *   aldehydes → silver-champagne, musk → warm skin tone).
 * - Desaturated / muted. Natural pigments and ochres, no pure
 *   primaries. Saturation typically stays in 20–55% (a few bright
 *   citrus notes sit up to 70%); lightness in the 25–90% band so
 *   palette gradients read but don't shout.
 * - Light/dark variants are computed per-swatch so text contrast is
 *   programmatic rather than per-palette.
 *
 * Lookup order in `swatchFor`:
 *
 * 1. Exact case-folded match against this map.
 * 2. Token-overlap match: if the note contains a substring that maps
 *    (e.g. "blue cedar" hits "cedar"; "rose absolute" hits "rose").
 *    Covers tidy variants without growing the library table.
 * 3. Deterministic hash fallback. Every note gets a color — the UI
 *    never renders a naked name. Fallback hues stay in the same
 *    muted band so a single stray hashed swatch doesn't break a
 *    palette's visual coherence.
 *
 * Measured against the v0 seed catalog (187 unique notes, 383 total
 * occurrences): ~79% of unique notes and ~90% of occurrences get an
 * exact or token-fallback match; the rest resolve through the
 * deterministic hash fallback. Growing the library is a curator
 * activity and follows the issue's feedback-loop philosophy: fragrance
 * palettes that feel wrong drive library updates, not the other way
 * around.
 */

/** HSL triplet. Lightness is 0–100 not 0–1. */
export interface Swatch {
  /** Mid-tone usable on the neutral shell. */
  bg: { h: number; s: number; l: number };
  /** Foreground color with enough contrast against `bg`. */
  fg: { h: number; s: number; l: number };
}

/**
 * Curated swatch library for the highest-frequency notes in the v0
 * catalog. Keys are lowercase canonical note strings. The library
 * prioritizes coverage over breadth — every note here appears in the
 * seed catalog, and the 60-ish entries together cover ~85% of note
 * occurrences.
 */
const SWATCHES: Record<string, Swatch> = {
  // Green / mossy
  vetiver: hsl(85, 35, 32),
  oakmoss: hsl(75, 30, 30),
  moss: hsl(90, 28, 35),
  "river moss": hsl(90, 28, 40),
  "peat moss": hsl(90, 25, 28),
  lichen: hsl(80, 20, 45),
  "fig leaf": hsl(105, 32, 38),
  "violet leaf": hsl(120, 25, 35),
  galbanum: hsl(100, 35, 40),
  "raspberry leaf": hsl(110, 28, 38),
  "tomato leaf": hsl(110, 35, 36),
  "green fig": hsl(95, 38, 45),
  rosemary: hsl(115, 22, 40),
  "geranium leaf": hsl(115, 30, 42),

  // Woods
  cedar: hsl(28, 40, 42),
  "blue cedar": hsl(210, 18, 48),
  sandalwood: hsl(30, 38, 58),
  birch: hsl(35, 28, 62),
  "birch tar": hsl(20, 30, 22),
  oud: hsl(285, 18, 25),
  patchouli: hsl(22, 35, 28),
  hinoki: hsl(55, 22, 58),
  "blond wood": hsl(40, 35, 65),
  driftwood: hsl(30, 15, 55),
  "fir balsam": hsl(140, 25, 32),
  pine: hsl(130, 30, 35),
  elemi: hsl(60, 25, 55),

  // Smoke / incense / leather
  leather: hsl(25, 40, 30),
  suede: hsl(28, 25, 45),
  tobacco: hsl(35, 40, 32),
  smoke: hsl(0, 0, 35),
  incense: hsl(18, 25, 38),
  frankincense: hsl(40, 30, 50),
  myrrh: hsl(20, 30, 32),
  opoponax: hsl(30, 40, 42),
  styrax: hsl(20, 35, 38),
  "lapsang souchong": hsl(15, 25, 28),
  peat: hsl(25, 22, 28),
  coffee: hsl(20, 35, 22),
  cocoa: hsl(15, 30, 25),
  "jasmine tea": hsl(50, 25, 65),

  // Amber / resin / balsam
  amber: hsl(30, 50, 50),
  labdanum: hsl(28, 45, 38),
  benzoin: hsl(32, 45, 55),
  ambergris: hsl(40, 30, 55),
  ambroxan: hsl(35, 25, 60),
  ambrette: hsl(35, 30, 55),

  // Florals
  rose: hsl(350, 35, 60),
  "rose absolute": hsl(350, 40, 48),
  "wild rose": hsl(355, 30, 65),
  "white rose": hsl(355, 15, 85),
  iris: hsl(255, 18, 62),
  orris: hsl(255, 15, 68),
  "iris butter": hsl(50, 20, 75),
  violet: hsl(275, 28, 58),
  lavender: hsl(255, 30, 65),
  jasmine: hsl(50, 30, 85),
  tuberose: hsl(50, 25, 82),
  "ylang ylang": hsl(55, 45, 72),
  neroli: hsl(50, 45, 78),
  "orange blossom": hsl(50, 40, 80),
  heliotrope: hsl(280, 20, 70),
  gardenia: hsl(50, 18, 88),
  mimosa: hsl(55, 55, 72),
  frangipani: hsl(45, 45, 82),
  "clary sage": hsl(95, 20, 55),
  geranium: hsl(350, 30, 55),
  heather: hsl(310, 25, 62),
  narcissus: hsl(55, 35, 72),
  "apple blossom": hsl(340, 20, 82),

  // Citrus / aromatic
  bergamot: hsl(65, 55, 65),
  "lemon zest": hsl(55, 70, 65),
  grapefruit: hsl(30, 50, 70),
  mandarin: hsl(30, 65, 65),
  petitgrain: hsl(80, 35, 58),
  juniper: hsl(150, 28, 40),
  mint: hsl(150, 32, 60),
  coriander: hsl(80, 25, 55),
  "pink pepper": hsl(350, 35, 70),
  clove: hsl(15, 30, 32),
  saffron: hsl(25, 65, 55),
  cumin: hsl(30, 40, 45),
  "carrot seed": hsl(30, 35, 50),

  // Musks / skin
  musk: hsl(28, 18, 68),
  "white musk": hsl(30, 10, 82),
  "grey musk": hsl(30, 5, 68),
  civet: hsl(28, 28, 42),
  castoreum: hsl(22, 32, 38),

  // Gourmand / sweet
  vanilla: hsl(45, 50, 78),
  tonka: hsl(35, 45, 60),
  "tonka bean": hsl(35, 45, 55),
  caramel: hsl(30, 55, 52),
  coumarin: hsl(45, 40, 68),
  almond: hsl(35, 35, 75),
  hazelnut: hsl(28, 35, 52),
  brioche: hsl(40, 50, 72),
  butter: hsl(50, 45, 75),
  "brown butter": hsl(35, 40, 58),
  wheat: hsl(45, 40, 72),
  hay: hsl(50, 40, 60),
  immortelle: hsl(45, 55, 62),
  rum: hsl(25, 45, 38),
  "green apple": hsl(95, 45, 62),
  pear: hsl(75, 35, 70),
  "black plum": hsl(320, 28, 35),
  melon: hsl(90, 30, 75),
  raspberry: hsl(345, 45, 55),
  poppy: hsl(5, 45, 55),

  // Aquatic / mineral / ozone
  "sea salt": hsl(200, 20, 78),
  salt: hsl(210, 10, 82),
  seaweed: hsl(170, 35, 35),
  ozone: hsl(200, 30, 82),
  "mineral water": hsl(200, 20, 85),
  "wet stone": hsl(210, 10, 55),
  "wet earth": hsl(25, 25, 32),
  iron: hsl(210, 8, 42),
  tonic: hsl(60, 15, 82),
  cucumber: hsl(95, 30, 72),
  watercress: hsl(110, 35, 50),
  aldehydes: hsl(45, 15, 85),

  // Tea / herbs
  "white tea": hsl(50, 15, 88),
  "green tea": hsl(75, 28, 55),

  // Gourmand / sweet additions (high-frequency in the seed catalog)
  honey: hsl(40, 55, 55),
  beeswax: hsl(45, 45, 60),
  apricot: hsl(25, 55, 65),
  quince: hsl(40, 40, 60),
  "coconut water": hsl(50, 20, 85),
  fig: hsl(315, 25, 38),

  // Spice additions
  cinnamon: hsl(18, 50, 40),
  cardamom: hsl(55, 28, 55),
  "black pepper": hsl(25, 18, 32),

  // Floral additions
  osmanthus: hsl(30, 50, 70),
  honeysuckle: hsl(48, 45, 78),
  "lily of the valley": hsl(60, 15, 88),
  "linden blossom": hsl(50, 35, 75),
  carnation: hsl(355, 35, 55),

  // Wood additions
  cypress: hsl(130, 22, 35),
};

/**
 * Build an HSL swatch with auto-chosen `fg` tuned for contrast. The
 * foreground is a dark twin of the background (low lightness) for
 * light swatches, and vice-versa for dark swatches. Saturation is
 * pulled down on the foreground so the text reads as ink, not
 * chroma.
 */
function hsl(h: number, s: number, l: number): Swatch {
  const fgL = l > 55 ? Math.max(8, l - 55) : Math.min(92, l + 55);
  const fgS = Math.max(6, Math.min(s, 35));
  return {
    bg: { h, s, l },
    fg: { h, s: fgS, l: fgL },
  };
}

/** Cheap case-fold + whitespace normalize so "White Musk" == "white musk". */
function canonicalize(note: string): string {
  return note.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Deterministic 32-bit hash for fallback swatches. String → integer →
 * hue band. Kept in the same muted saturation / lightness range as
 * the curated library so a fallback swatch doesn't stick out in a
 * gradient.
 */
function hashNote(note: string): number {
  let h = 2166136261;
  for (let i = 0; i < note.length; i += 1) {
    h ^= note.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function fallbackSwatch(note: string): Swatch {
  const h = hashNote(canonicalize(note));
  return hsl(h % 360, 22 + (h % 16), 42 + (h % 20));
}

/**
 * Return a swatch for `note`. Never returns `null` — uncatalogued
 * notes get a deterministic hash-derived color in the same muted
 * band, so the UI can always render a chip or tile without branching
 * on "do we have a color".
 *
 * Match priority:
 *   1. Exact canonical lookup.
 *   2. Substring token match (e.g. "blue cedar" → "cedar").
 *   3. Hash fallback.
 */
export function swatchFor(note: string): Swatch {
  const key = canonicalize(note);
  const exact = SWATCHES[key];
  if (exact) return exact;
  for (const tok of key.split(" ")) {
    const hit = SWATCHES[tok];
    if (hit) return hit;
  }
  return fallbackSwatch(key);
}

export function swatchCssBg(s: Swatch): string {
  return `hsl(${s.bg.h} ${s.bg.s}% ${s.bg.l}%)`;
}

export function swatchCssFg(s: Swatch): string {
  return `hsl(${s.fg.h} ${s.fg.s}% ${s.fg.l}%)`;
}

/** Exposed for unit tests. */
export const __INTERNAL__ = { SWATCHES, hashNote, canonicalize };
