/**
 * Unit tests for the pure write-guard helpers in
 * `lib/server/write-guards.ts`.
 *
 * Pure input → output contracts only. The integration tests exercise
 * the same helpers through the real server actions against an
 * in-process PDS; those are the ones that prove end-to-end that bad
 * input never reaches `lexClient.create`.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeNoteString,
  normalizeNotes,
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
