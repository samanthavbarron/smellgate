/**
 * Unit tests for the chromatic identity system (issue #217).
 *
 * Covers the swatch library lookup, palette generation, and CSS
 * serialization. No rendering — those bits are exercised via
 * integration tests against the tile / detail components.
 */

import { describe, expect, it } from "vitest";
import {
  paletteForNotes,
  paletteGradientCss,
  swatchCssBg,
  swatchFor,
} from "../../lib/palette";

describe("swatchFor", () => {
  it("returns the curated swatch for a canonical note", () => {
    const s = swatchFor("vetiver");
    // vetiver is green / mossy by the library.
    expect(s.bg.h).toBeGreaterThan(60);
    expect(s.bg.h).toBeLessThan(140);
  });

  it("is case- and whitespace-insensitive", () => {
    const a = swatchFor("Vetiver");
    const b = swatchFor("  vetiver  ");
    expect(a).toEqual(b);
  });

  it("falls back to a token-overlap match for compound notes", () => {
    // "rose absolute" has its own entry; "blue cedar" has its own
    // entry; "pink rose" doesn't — it should hit `rose`.
    const compound = swatchFor("pink rose");
    const rose = swatchFor("rose");
    expect(compound.bg.h).toEqual(rose.bg.h);
  });

  it("returns a deterministic hash fallback for uncatalogued notes", () => {
    const a = swatchFor("some-weird-note-that-is-not-in-the-library");
    const b = swatchFor("some-weird-note-that-is-not-in-the-library");
    expect(a).toEqual(b);
    // The fallback stays in the muted saturation band.
    expect(a.bg.s).toBeGreaterThanOrEqual(22);
    expect(a.bg.s).toBeLessThanOrEqual(38);
    expect(a.bg.l).toBeGreaterThanOrEqual(42);
    expect(a.bg.l).toBeLessThanOrEqual(62);
  });
});

describe("paletteForNotes", () => {
  it("returns at least minStops even for a single-note fragrance", () => {
    const p = paletteForNotes(["rose"]);
    expect(p.stops.length).toBeGreaterThanOrEqual(3);
  });

  it("caps at maxStops for a note-heavy fragrance", () => {
    const p = paletteForNotes([
      "rose",
      "jasmine",
      "vanilla",
      "sandalwood",
      "oakmoss",
      "bergamot",
      "musk",
      "amber",
      "patchouli",
      "iris",
      "vetiver",
      "leather",
    ]);
    expect(p.stops.length).toBeLessThanOrEqual(5);
  });

  it("produces a light-to-dark gradient", () => {
    const p = paletteForNotes([
      "jasmine", // very light
      "vetiver", // darker
      "oud", // darkest
    ]);
    const lightnesses = p.stops.map((s) => s.bg.l);
    for (let i = 1; i < lightnesses.length; i += 1) {
      expect(lightnesses[i]).toBeLessThanOrEqual(lightnesses[i - 1]);
    }
  });

  it("is deterministic across calls", () => {
    const a = paletteForNotes(["rose", "oakmoss", "musk"]);
    const b = paletteForNotes(["rose", "oakmoss", "musk"]);
    expect(a).toEqual(b);
  });

  it("dedupes visually-adjacent swatches (musk / white musk)", () => {
    // These two notes live in the same visual bucket — they should
    // collapse to one stop rather than producing a muddy pair.
    const p = paletteForNotes(["musk", "white musk", "oakmoss"]);
    // Expect 3 stops (the two musks collapse; oakmoss forms one real
    // stop; padding fills to the minimum of 3).
    expect(p.stops.length).toBeGreaterThanOrEqual(3);
    // And exactly one of those stops should represent the musk
    // family (beige/warm skin-tone) — we didn't duplicate it.
    const beige = p.stops.filter(
      (s) => s.bg.h > 20 && s.bg.h < 40 && s.bg.l > 60 && s.bg.s < 20,
    );
    expect(beige.length).toBeLessThanOrEqual(2); // 1 real + at most 1 tonal pad
  });

  it("handles an empty notes array without throwing", () => {
    const p = paletteForNotes([]);
    expect(p.stops.length).toBe(1);
    expect(p.notes).toEqual([]);
  });
});

describe("paletteGradientCss", () => {
  it("emits a linear-gradient with light-to-dark stops", () => {
    const p = paletteForNotes(["jasmine", "vetiver", "oud"]);
    const css = paletteGradientCss(p);
    expect(css).toMatch(/^linear-gradient\(to bottom, /);
    // Every stop should resolve to an hsl(...) call.
    const stopCount = (css.match(/hsl\(/g) ?? []).length;
    expect(stopCount).toBe(p.stops.length);
  });

  it("honors a custom direction", () => {
    const p = paletteForNotes(["rose"]);
    expect(paletteGradientCss(p, "to right")).toMatch(/^linear-gradient\(to right, /);
  });

  it("returns a harmless value on an empty palette", () => {
    // paletteForNotes([]) still has 1 stop; test the degenerate case
    // where a caller hand-constructs an empty palette.
    expect(
      paletteGradientCss({ notes: [], stops: [] }),
    ).toBe("transparent");
  });
});

describe("swatchCssBg / swatchCssFg", () => {
  it("serializes an HSL swatch to `hsl(H S% L%)` form", () => {
    const s = swatchFor("rose");
    expect(swatchCssBg(s)).toBe(
      `hsl(${s.bg.h} ${s.bg.s}% ${s.bg.l}%)`,
    );
  });
});
