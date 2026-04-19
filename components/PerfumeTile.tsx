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
import {
  paletteForNotes,
  paletteGradientCss,
  swatchCssBg,
  swatchCssFg,
  swatchFor,
} from "@/lib/palette";

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
  // Issue #217: derive a light-to-dark palette from the full note list
  // (not just the 3 displayed chips) so the gradient reflects the
  // whole fragrance, not the arbitrary first-3 slice.
  const palette = paletteForNotes(perfume.notes);
  return (
    <Link
      href={href}
      data-smellgate-perfume={perfume.uri}
      className="block h-full overflow-hidden rounded-lg border border-zinc-200 bg-white transition-colors hover:border-amber-600 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-amber-500"
    >
      <div
        aria-hidden
        className="h-16 w-full"
        style={{ background: paletteGradientCss(palette, "to right") }}
      />
      <div className="p-4">
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
            {topNotes.map((note) => (
              <NoteChip
                key={note}
                note={note}
                emphasize={highlight !== undefined && note === highlight}
              />
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

/**
 * Note chip coloured by the note's swatch. `emphasize=true` on the
 * chip matching the tag-page highlight adds a ring so the tag is
 * still discernible when the surrounding palette is already using
 * its color.
 */
export function NoteChip({
  note,
  emphasize = false,
}: {
  note: string;
  emphasize?: boolean;
}) {
  const sw = swatchFor(note);
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium" +
        (emphasize
          ? " ring-2 ring-offset-1 ring-zinc-800 dark:ring-zinc-100 dark:ring-offset-zinc-900"
          : "")
      }
      style={{
        background: swatchCssBg(sw),
        color: swatchCssFg(sw),
      }}
    >
      {note}
    </span>
  );
}
