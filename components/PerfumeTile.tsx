/**
 * A grid tile for a perfume, shared by the home page (Phase 4.A), the
 * perfume detail page, and the tag pages (Phase 4.B).
 *
 * Extraction rationale: three call sites now use the same shape —
 * per docs/ui.md "Share components, not class strings", that's our
 * cue to lift this out of `app/page.tsx` and into `components/`.
 */
import Link from "next/link";
import type { PerfumeWithNotes } from "@/lib/db/smellgate-queries";

export function PerfumeTile({ perfume }: { perfume: PerfumeWithNotes }) {
  const href = `/perfume/${encodeURIComponent(perfume.uri)}`;
  const topNotes = perfume.notes.slice(0, 3);
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
          {topNotes.map((note) => (
            <span
              key={note}
              className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            >
              {note}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}
