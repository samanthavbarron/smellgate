/**
 * Shared write-layer guards for the smellgate server actions.
 *
 * The writeGuards PR (bug-bash blockers #128, #129, #130, #135, #138,
 * #141) is organized around one idea: **the write layer must validate,
 * the render layer must escape.** This module is the validate half —
 * pure functions that take raw, user-submitted input and return a
 * normalized / sanitized version (or throw an ActionError if the input
 * is rejected outright).
 *
 * Two concerns live here:
 *
 *   1. `normalizeNotes` — canonicalize a `notes[]` array for
 *      `com.smellgate.perfumeSubmission` (and, via the curator approve
 *      path, for `com.smellgate.perfume`). NFC unicode, trim, collapse
 *      internal whitespace, lowercase, strip leading/trailing emoji,
 *      dedupe in order. Rejects whitespace-only entries (issue #128).
 *
 *   2. `sanitizeFreeText` — strip HTML from a free-text field before
 *      it ever reaches `lexClient.create`. This is defense-in-depth:
 *      every known render path uses React text interpolation (which
 *      escapes by default), but if someone ever adds a
 *      `dangerouslySetInnerHTML` pipeline or a markdown renderer, the
 *      stored value must already be safe. We strip (rather than
 *      allow-list) because our fields are plaintext-only today — no
 *      markdown, no links, no formatting. Issues #129 / #130.
 *
 * We also export a `stripHtmlToPlaintext` seam so tests can assert the
 * exact transform without going through the sanitizer's allowedTags
 * config.
 */

import sanitizeHtml from "sanitize-html";
import { ActionError } from "./smellgate-actions";

// ---------------------------------------------------------------------------
// Note normalization (issue #128)
// ---------------------------------------------------------------------------

/**
 * Regex matching leading or trailing emoji / emoji-like symbols. We
 * use Unicode property escapes (`\p{Extended_Pictographic}`) which
 * match the full emoji set including modifiers. The pattern also
 * catches combining variation selectors (`\uFE0F`) and zero-width
 * joiners (`\u200D`) that typically trail emoji sequences.
 *
 * This intentionally only strips emoji at the **edges** of the note.
 * A note like "rose 🌹 pink" would keep the middle emoji; a note like
 * "🌸 rose" would get the leading flower stripped. The bug-bash
 * reproduction (#128) surfaced emoji-prefixed notes as the concrete
 * problem; interior emoji in a legitimate note are harmless and
 * surgically removing them would be more disruptive than useful.
 */
const EDGE_EMOJI_RE =
  /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+|[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/gu;

/**
 * Normalize a single raw note string. Returns `null` if the input is
 * empty or whitespace-only after normalization (so the caller can
 * reject the whole array).
 *
 * Steps (in order):
 *   1. NFC unicode normalization.
 *   2. Trim.
 *   3. Collapse internal whitespace (any run of whitespace becomes a
 *      single space).
 *   4. Lowercase.
 *   5. Strip leading/trailing emoji.
 *   6. Trim again (step 5 may have exposed new edge whitespace).
 */
export function normalizeNoteString(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.normalize("NFC");
  s = s.trim();
  s = s.replace(/\s+/g, " ");
  s = s.toLowerCase();
  s = s.replace(EDGE_EMOJI_RE, "");
  s = s.trim();
  if (s.length === 0) return null;
  return s;
}

/**
 * Normalize a `notes[]` array. Throws `ActionError(400, ...)` if the
 * array is missing, empty, non-array, contains a non-string, or
 * contains a whitespace-only / emoji-only entry. Dedupes case-folded
 * duplicates preserving first-seen order.
 *
 * The return array is what the caller should hand to
 * `lexClient.create`; it also echoes up through the server-action
 * response so the submitter can see what got stored (per the issue
 * body: "silent normalization without echo is almost as bad as no
 * normalization").
 */
export function normalizeNotes(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ActionError(400, "notes must be a non-empty array");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new ActionError(400, "notes must be an array of strings");
    }
    const norm = normalizeNoteString(entry);
    if (norm === null) {
      throw new ActionError(
        400,
        "notes must not contain whitespace-only or emoji-only entries",
      );
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  if (out.length === 0) {
    // Unreachable given the input was non-empty and we threw on
    // whitespace-only entries, but cheap belt-and-braces.
    throw new ActionError(400, "notes must be a non-empty array");
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML sanitization (issues #129 / #130)
// ---------------------------------------------------------------------------

/**
 * Strip all HTML tags from a string, returning plaintext. Entities
 * are decoded by the sanitizer so `&amp;` becomes `&` etc. — the
 * render layer will re-escape when it interpolates the string into
 * JSX.
 *
 * We pass `allowedTags: []` + `allowedAttributes: {}` rather than
 * using sanitize-html's default allow-list. The fields we store
 * (review/description/comment bodies, perfume descriptions,
 * submission rationales) are plaintext-only today; if we ever adopt
 * markdown or a rich editor, that's a deliberate change with its own
 * review.
 *
 * `disallowedTagsMode: "discard"` drops the tag AND its content for
 * known-dangerous tags so that `<script>alert(1)</script>` becomes
 * `""` rather than `"alert(1)"`. This matches a submitter's intuition
 * ("I typed a `<script>` tag and nothing's there now") better than
 * silent content leakage.
 */
export function stripHtmlToPlaintext(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    // Drop the contents of <script>/<style>/<iframe> entirely rather
    // than extracting their text (the sanitize-html default for these
    // tags is already to discard content, but we restate it here for
    // clarity and so it's covered by our own tests).
    disallowedTagsMode: "discard",
    // Don't expand entity references or try to preserve whitespace in
    // any special way — plain text round-trips.
  });
}

/**
 * Sanitize a free-text body for a write path. The returned string
 * must pass the lexicon's own min/max length checks; if stripping
 * tags yields an empty string, we throw 400 so the user gets a real
 * error instead of a silently-blank record.
 *
 * `name` is only used in error messages.
 */
export function sanitizeFreeText(raw: string, name: string): string {
  if (typeof raw !== "string") {
    throw new ActionError(400, `${name} must be a string`);
  }
  const stripped = stripHtmlToPlaintext(raw);
  // Normalize CR/LF to LF only — lexicons treat body as plain text and
  // we don't want to mint two "equal" descriptions that differ only in
  // their line endings. (This is purely a consistency improvement;
  // sanitize-html does not touch line endings.)
  const normalized = stripped.replace(/\r\n?/g, "\n");
  if (normalized.trim().length === 0) {
    throw new ActionError(
      400,
      `${name} must not be empty (after HTML sanitization)`,
    );
  }
  return normalized;
}
