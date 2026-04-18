/**
 * Search page (Phase 4.F, issue #71).
 *
 * Server component. Reads `?q=<query>` from the URL and runs a
 * bare-bones substring search against the cached perfume catalog via
 * `searchPerfumes`. The query input is extracted to
 * `components/SearchInput.tsx` (a client component) because it owns
 * local state and needs to `router.push` on submit.
 *
 * Shape follows the Phase 4.B tag pages: header + grid of
 * `PerfumeTile`. Empty state copy mirrors `TagPage` for consistency.
 *
 * Next 16 hands `searchParams` as a Promise — same convention the
 * Phase 4.B route params use.
 */
import { getDb } from "@/lib/db";
import { searchPerfumes } from "@/lib/db/smellgate-queries";
import { PerfumeTile } from "@/components/PerfumeTile";
import { SearchInput } from "@/components/SearchInput";

type SearchParams = Promise<{ q?: string | string[] }>;

function firstParam(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

/**
 * Cap on `?q=` length (issue #179). The server-side substring search
 * against SQLite doesn't care about length; the render path does — a
 * 2000-char query blows past the layout container. 200 chars matches
 * the lexicon's `maxGraphemes` bound on perfume name/house/creator,
 * which is the longest legitimate thing a user could want to search
 * for.
 */
const MAX_QUERY_LENGTH = 200;

function clampQuery(raw: string): string {
  return raw.length <= MAX_QUERY_LENGTH ? raw : raw.slice(0, MAX_QUERY_LENGTH);
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const query = clampQuery(firstParam(sp.q).trim());

  if (query.length === 0) {
    return (
      <div className="space-y-8">
        <header>
          <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Search
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Search by perfume name, house, creator, or note.
          </p>
        </header>
        <div className="mx-auto max-w-xl">
          <SearchInput autoFocus />
        </div>
      </div>
    );
  }

  const db = getDb();
  const perfumes = await searchPerfumes(db, query);

  return (
    <div className="space-y-8">
      <header>
        <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
          Search
        </div>
        <h1 className="mt-1 text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {query}
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {perfumes.length === 0
            ? `No perfumes match \u201C${query}\u201D`
            : `${perfumes.length} perfume${perfumes.length === 1 ? "" : "s"}`}
        </p>
      </header>

      <SearchInput initialQuery={query} />

      {perfumes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          No perfumes match &ldquo;{query}&rdquo;. Try a shorter substring,
          or a different spelling — this is a plain substring search
          matching any of: name, house, creator, or note. No fuzzy
          matching. You can also browse directly via{" "}
          <a
            href={`/tag/creator/${encodeURIComponent(query)}`}
            className="text-amber-700 underline hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
          >
            /tag/creator/{query}
          </a>{" "}
          or{" "}
          <a
            href={`/tag/note/${encodeURIComponent(query)}`}
            className="text-amber-700 underline hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
          >
            /tag/note/{query}
          </a>{" "}
          if you know the exact value.
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
