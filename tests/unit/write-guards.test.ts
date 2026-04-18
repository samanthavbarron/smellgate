/**
 * Unit tests for the pure write-guard helpers in
 * `lib/server/write-guards.ts`.
 *
 * Pure input → output contracts only. The integration tests exercise
 * the same helpers through the real server actions against an
 * in-process PDS; those are the ones that prove end-to-end that bad
 * input never reaches `lexClient.create`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentMaxReleaseYear,
  MAX_SHORT_IDENTIFIER_GRAPHEMES,
  MIN_RELEASE_YEAR,
  normalizeNoteString,
  normalizeNotes,
  RELEASE_YEAR_FUTURE_OFFSET,
  requireBoundedIdentifier,
  requireReleaseYear,
  sanitizeFreeText,
  stripHtmlToPlaintext,
} from "../../lib/server/write-guards";
import { ActionError } from "../../lib/server/smellgate-actions";

describe("normalizeNoteString", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeNoteString("   rose   ")).toBe("rose");
  });

  it("lowercases", () => {
    expect(normalizeNoteString("RoSe")).toBe("rose");
  });

  it("collapses internal whitespace and strips newlines", () => {
    expect(normalizeNoteString("rose   absolute")).toBe("rose absolute");
    expect(normalizeNoteString("rose\nabsolute")).toBe("rose absolute");
    expect(normalizeNoteString("rose\t  \tabsolute")).toBe("rose absolute");
    // Trailing newline should be trimmed.
    expect(normalizeNoteString("rose\n")).toBe("rose");
  });

  it("strips leading/trailing emoji but preserves interior", () => {
    expect(normalizeNoteString("🌸 rose")).toBe("rose");
    expect(normalizeNoteString("rose 🫶")).toBe("rose");
    expect(normalizeNoteString("🌸 rose 🫶")).toBe("rose");
  });

  it("applies NFC normalization", () => {
    // "é" as a composed char vs. as e + combining acute.
    const composed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    expect(normalizeNoteString(composed)).toBe(
      normalizeNoteString(decomposed),
    );
  });

  it("returns null for whitespace-only", () => {
    expect(normalizeNoteString("   ")).toBeNull();
    expect(normalizeNoteString("")).toBeNull();
    expect(normalizeNoteString("\n\t")).toBeNull();
  });

  it("returns null for emoji-only", () => {
    expect(normalizeNoteString("🌸")).toBeNull();
    expect(normalizeNoteString("🌸 🫶")).toBeNull();
  });

  it("returns null for non-strings", () => {
    expect(normalizeNoteString(42 as unknown as string)).toBeNull();
  });
});

describe("normalizeNotes", () => {
  it("dedupes case-folded and whitespace-variant entries preserving order", () => {
    // The carol/bugbash repro from issue #128.
    const out = normalizeNotes([
      "🌸 rose",
      "RoSe",
      "   rose   ",
      "rose\n",
      "rose 🫶",
      "oud",
    ]);
    expect(out).toEqual(["rose", "oud"]);
  });

  it("preserves first-seen order on duplicates", () => {
    expect(normalizeNotes(["jasmine", "ROSE", "jasmine", "rose"])).toEqual([
      "jasmine",
      "rose",
    ]);
  });

  it("throws 400 on an empty array", () => {
    expect(() => normalizeNotes([])).toThrow(ActionError);
    try {
      normalizeNotes([]);
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).status).toBe(400);
    }
  });

  it("throws 400 on non-array input", () => {
    expect(() => normalizeNotes(null)).toThrow(ActionError);
    expect(() => normalizeNotes("rose")).toThrow(ActionError);
    expect(() => normalizeNotes(undefined)).toThrow(ActionError);
  });

  it("throws 400 on non-string entries", () => {
    expect(() => normalizeNotes(["rose", 42])).toThrow(ActionError);
    expect(() => normalizeNotes([null])).toThrow(ActionError);
  });

  it("throws 400 on whitespace-only or emoji-only entries", () => {
    expect(() => normalizeNotes(["rose", "   "])).toThrow(ActionError);
    expect(() => normalizeNotes(["rose", "🌸"])).toThrow(ActionError);
  });
});

describe("stripHtmlToPlaintext", () => {
  it("drops script tags and their content entirely", () => {
    const out = stripHtmlToPlaintext(
      'Smells like <script>alert("xss")</script> pine needles.',
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(");
    expect(out).toContain("pine needles");
  });

  it("drops img event handlers", () => {
    const out = stripHtmlToPlaintext(
      'Hello <img src=x onerror=alert(1)> world',
    );
    expect(out).not.toContain("<img");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(");
    expect(out).toContain("Hello");
    expect(out).toContain("world");
  });

  it("leaves plain text untouched", () => {
    expect(stripHtmlToPlaintext("Crisp aromatic with a clean drydown.")).toBe(
      "Crisp aromatic with a clean drydown.",
    );
  });

  it("does not preserve any HTML tag", () => {
    const out = stripHtmlToPlaintext(
      "<b>bold</b> and <a href='http://evil.com'>link</a>",
    );
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("bold");
    expect(out).toContain("link");
  });

  it("strips javascript: URL content via the containing tag", () => {
    // The sanitizer drops the <a> tag; the visible text remains.
    // The important thing is the `javascript:` URL is not preserved
    // as an attribute that a downstream renderer could act on.
    const out = stripHtmlToPlaintext(
      '<a href="javascript:alert(1)">click</a>',
    );
    expect(out).toContain("click");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("href=");
  });
});

describe("sanitizeFreeText", () => {
  it("rejects a body that is entirely HTML", () => {
    expect(() => sanitizeFreeText("<script>evil()</script>", "body")).toThrow(
      ActionError,
    );
  });

  it("returns plaintext for a body that mixes HTML and text", () => {
    const out = sanitizeFreeText(
      "Before <script>alert(1)</script> after.",
      "body",
    );
    expect(out).not.toContain("<script");
    expect(out).toContain("Before");
    expect(out).toContain("after");
  });

  it("rejects a non-string", () => {
    expect(() => sanitizeFreeText(42 as unknown as string, "body")).toThrow(
      ActionError,
    );
  });

  it("normalizes CRLF to LF", () => {
    expect(sanitizeFreeText("line1\r\nline2", "body")).toBe("line1\nline2");
  });

  it("preserves plain text unchanged", () => {
    expect(sanitizeFreeText("A real review body.", "body")).toBe(
      "A real review body.",
    );
  });
});

// ---------------------------------------------------------------------------
// Short-identifier length bound (issue #134)
// ---------------------------------------------------------------------------

describe("requireBoundedIdentifier", () => {
  it("exports a cap of 200 graphemes", () => {
    expect(MAX_SHORT_IDENTIFIER_GRAPHEMES).toBe(200);
  });

  it("returns the trimmed string for a normal value", () => {
    expect(requireBoundedIdentifier("  Guerlain  ", "house")).toBe("Guerlain");
  });

  it("accepts exactly 200 graphemes (inclusive)", () => {
    const s = "a".repeat(200);
    expect(requireBoundedIdentifier(s, "name")).toBe(s);
  });

  it("rejects 201 graphemes with a 400 ActionError", () => {
    const s = "a".repeat(201);
    expect(() => requireBoundedIdentifier(s, "name")).toThrow(ActionError);
    try {
      requireBoundedIdentifier(s, "name");
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).status).toBe(400);
      expect((err as ActionError).message).toContain("name");
    }
  });

  it("rejects a 5000-char name (the issue #134 repro)", () => {
    expect(() =>
      requireBoundedIdentifier("A".repeat(5000), "name"),
    ).toThrow(ActionError);
  });

  it("rejects empty and whitespace-only", () => {
    expect(() => requireBoundedIdentifier("", "name")).toThrow(ActionError);
    expect(() => requireBoundedIdentifier("   ", "name")).toThrow(ActionError);
  });

  it("rejects non-strings", () => {
    expect(() =>
      requireBoundedIdentifier(42 as unknown as string, "name"),
    ).toThrow(ActionError);
    expect(() =>
      requireBoundedIdentifier(null as unknown as string, "name"),
    ).toThrow(ActionError);
    expect(() =>
      requireBoundedIdentifier(undefined as unknown as string, "name"),
    ).toThrow(ActionError);
  });

  it("counts graphemes, not UTF-16 code units", () => {
    // 🏳️‍🌈 is 1 grapheme but 8 UTF-16 code units. 200 copies = 200
    // graphemes = under the cap; `.length`-based validation would
    // incorrectly reject this.
    const flag = "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}";
    const input = flag.repeat(200);
    expect(input.length).toBeGreaterThan(200); // sanity: code-unit count is much larger
    expect(requireBoundedIdentifier(input, "name")).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// releaseYear plausibility bound (issue #133)
// ---------------------------------------------------------------------------

describe("requireReleaseYear", () => {
  beforeEach(() => {
    // Pin the clock to 2026-04-17 (the date in the issue body context) —
    // so `currentMaxReleaseYear()` is deterministic at 2027.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports 1700 as the minimum and +1 as the future offset", () => {
    expect(MIN_RELEASE_YEAR).toBe(1700);
    expect(RELEASE_YEAR_FUTURE_OFFSET).toBe(1);
  });

  it("currentMaxReleaseYear picks UTC year + 1", () => {
    expect(currentMaxReleaseYear()).toBe(2027);
  });

  it("currentMaxReleaseYear is UTC-stable at year-end", () => {
    // 2026-12-31T23:30:00Z is 2026 in UTC, but 2027 in some
    // east-of-UTC timezones. The guard reads UTC so the bound is
    // 2027, not 2028 — no matter where the server runs.
    vi.setSystemTime(new Date("2026-12-31T23:30:00Z"));
    expect(currentMaxReleaseYear()).toBe(2027);
  });

  it("accepts currentYear + 1 (pre-announcement)", () => {
    expect(requireReleaseYear(2027)).toBe(2027);
  });

  it("accepts 1700 (lower bound inclusive)", () => {
    expect(requireReleaseYear(1700)).toBe(1700);
  });

  it("rejects 2099 with 400 (issue #133 repro)", () => {
    expect(() => requireReleaseYear(2099)).toThrow(ActionError);
    try {
      requireReleaseYear(2099);
    } catch (err) {
      expect((err as ActionError).status).toBe(400);
      expect((err as ActionError).message).toMatch(/1700.*2027/);
    }
  });

  it("rejects -500", () => {
    expect(() => requireReleaseYear(-500)).toThrow(ActionError);
  });

  it("rejects 42 (issue #133 suspected low-end case)", () => {
    expect(() => requireReleaseYear(42)).toThrow(ActionError);
  });

  it("rejects 1699 (just below lower bound)", () => {
    expect(() => requireReleaseYear(1699)).toThrow(ActionError);
  });

  it("rejects currentYear + 2 (just above upper bound)", () => {
    expect(() => requireReleaseYear(2028)).toThrow(ActionError);
  });

  it("rejects non-integers (float, NaN, Infinity, string)", () => {
    expect(() => requireReleaseYear(2020.5)).toThrow(ActionError);
    expect(() => requireReleaseYear(Number.NaN)).toThrow(ActionError);
    expect(() => requireReleaseYear(Number.POSITIVE_INFINITY)).toThrow(
      ActionError,
    );
    expect(() => requireReleaseYear("2020" as unknown as number)).toThrow(
      ActionError,
    );
    expect(() => requireReleaseYear(null as unknown as number)).toThrow(
      ActionError,
    );
  });
});
