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

export function TagPage({
  kindLabel,
  value,
  perfumes,
}: {
  kindLabel: string;
  value: string;
  perfumes: PerfumeWithNotes[];
}) {
  return (
    <div className="space-y-8">
      <header>
        <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
          {kindLabel}
        </div>
        <h1 className="mt-1 text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {value}
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {perfumes.length === 0
            ? "No perfumes found."
            : `${perfumes.length} perfume${perfumes.length === 1 ? "" : "s"}`}
        </p>
      </header>

      {perfumes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          Nothing in the cache matches this tag. The firehose may not
          have indexed anything here yet, or the spelling differs.
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {perfumes.map((p) => (
            <li key={p.uri}>
              <PerfumeTile perfume={p} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
