/**
 * Shared renderer for the three Phase 4.B tag pages
 * (by note, by house, by creator). Each page is otherwise identical —
 * they differ only in the query they call and the header label — so
 * they pass the resolved perfume list into this component rather than
 * duplicating the same JSX three times.
 *
 * Extraction rationale: three call sites, identical markup. Per
 * docs/ui.md we share components, not class strings.
 */
import type { PerfumeWithNotes } from "@/lib/db/smellgate-queries";
import { PerfumeTile } from "@/components/PerfumeTile";

/**
 * Upper bound on the tag `value` we'll render in the H1. The route
 * segment accepts anything a URL path can carry, so a pasted 1200-
 * character string would otherwise blow past the `max-w-5xl` layout
 * container (issue #179). 200 graphemes matches the lexicon's
 * `maxGraphemes` bound on `perfume.name` / `house` / `creator` — a
 * real value never exceeds this, and anything that does is either a
 * typo or an attacker trying to break layout.
 */
const MAX_TAG_VALUE_DISPLAY_LENGTH = 200;

function truncateForDisplay(value: string): string {
  if (value.length <= MAX_TAG_VALUE_DISPLAY_LENGTH) return value;
  return value.slice(0, MAX_TAG_VALUE_DISPLAY_LENGTH) + "…";
}

export function TagPage({
  kindLabel,
  value,
  perfumes,
  highlightNote,
}: {
  kindLabel: string;
  value: string;
  perfumes: PerfumeWithNotes[];
  /**
   * When set, each tile will pin this note first in its 3-chip note
   * slice and style it more prominently (#120). Only set from the
   * by-note tag page — house and creator tag pages have nothing to
   * highlight on the tile, since the tile doesn't render house/creator
   * as chips.
   */
  highlightNote?: string;
}) {
  return (
    <div className="space-y-8">
      <header>
        <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
          {kindLabel}
        </div>
        <h1 className="mt-1 break-words text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {truncateForDisplay(value)}
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {perfumes.length === 0
            ? "No perfumes found."
            : `${perfumes.length} perfume${perfumes.length === 1 ? "" : "s"}`}
        </p>
      </header>

      {perfumes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          No perfumes match this tag. Check the spelling, or try a different
          tag.
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {perfumes.map((p) => (
            <li key={p.uri}>
              <PerfumeTile perfume={p} highlight={highlightNote} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
