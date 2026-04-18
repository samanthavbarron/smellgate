/**
 * A grid tile for a perfume, shared by the home page (Phase 4.A), the
 * perfume detail page, and the tag pages (Phase 4.B).
 *
 * Extraction rationale: three call sites now use the same shape —
 * per docs/ui.md "Share components, not class strings", that's our
 * cue to lift this out of `app/page.tsx` and into `components/`.
 *
 * `highlight` prop (#120): when set, the tile's 3-chip note slice is
 * guaranteed to include the highlighted note pinned in the first slot
 * and visually emphasized. This matters on `/tag/note/<note>` pages,
 * where the pre-existing `notes.slice(0, 3)` behavior picks the first
 * three notes alphabetically and routinely hides the very tag the
 * user just clicked. If `highlight` isn't in the perfume's notes (a
 * defensive case that shouldn't occur on a matched-tag page), the
 * tile falls through to the original behavior.
 */
import Link from "next/link";
import type { PerfumeWithNotes } from "@/lib/db/smellgate-queries";

const MAX_CHIPS = 3;

function pickDisplayedNotes(
  notes: string[],
  highlight: string | undefined,
): string[] {
  if (!highlight) return notes.slice(0, MAX_CHIPS);
  const idx = notes.indexOf(highlight);
  if (idx === -1) return notes.slice(0, MAX_CHIPS);
  // Pin `highlight` first; fill the remaining slots with the next
  // notes from the perfume's full list, preserving natural order
  // after skipping the highlighted index.
  const rest = notes.filter((_, i) => i !== idx);
  return [highlight, ...rest.slice(0, MAX_CHIPS - 1)];
}

export function PerfumeTile({
  perfume,
  highlight,
}: {
  perfume: PerfumeWithNotes;
  highlight?: string;
}) {
  const href = `/perfume/${encodeURIComponent(perfume.uri)}`;
  const topNotes = pickDisplayedNotes(perfume.notes, highlight);
  return (
    <Link
      href={href}
      data-smellgate-perfume={perfume.uri}
      className="block h-full rounded-lg border border-zinc-200 bg-white p-4 transition-colors hover:border-amber-600 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-amber-500"
    >
      <div className="text-base font-medium text-zinc-900 dark:text-zinc-100">
        {perfume.name}
      </div>
      <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
        {perfume.house}
        {perfume.creator ? ` · ${perfume.creator}` : ""}
        {perfume.release_year ? ` · ${perfume.release_year}` : ""}
      </div>
      {topNotes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {topNotes.map((note) => {
            const isHighlighted = highlight !== undefined && note === highlight;
            // Highlighted chip: bolder weight + darker zinc shade
            // (zinc-200/zinc-700 vs the default zinc-100/zinc-800).
            // Per docs/ui.md, amber is reserved for link semantics —
            // do not re-use it for tag highlighting.
            const chipClass = isHighlighted
              ? "inline-flex items-center rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100"
              : "inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
            return (
              <span key={note} className={chipClass}>
                {note}
              </span>
            );
          })}
        </div>
      )}
    </Link>
  );
}
