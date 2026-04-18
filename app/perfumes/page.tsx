/**
 * Browse-all perfumes page (issue #122).
 *
 * Server component. Pages through every row in `smellgate_perfume`
 * newest-first (`indexed_at DESC`, same ordering the home page's
 * "Recent perfumes" section uses — see `getRecentPerfumes`).
 *
 * Pagination: simple offset-based `?page=N`. The seeded catalog is
 * 75 rows; even at 10k rows the table scan is cheap enough that
 * offset pagination doesn't earn cursor-based complexity. If we ever
 * need stable pagination across concurrent writes (a row inserted
 * between "page 1" and "page 2" can shift a row into page 2), revisit
 * then — this app's write rate makes that effectively a non-issue
 * today.
 *
 * `?page` is clamped via `resolvePage` — asking for `?page=9999`
 * against a small catalog renders the last real page rather than an
 * empty grid.
 *
 * Page size is 24 (multiple of the 3-column grid — see docs/ui.md —
 * so each page fills a complete final row on desktop).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import {
  countPerfumes,
  getRecentPerfumes,
} from "@/lib/db/smellgate-queries";
import { PerfumeTile } from "@/components/PerfumeTile";
import { parsePageParam, resolvePage } from "@/lib/pagination";

const PAGE_SIZE = 24;

type SearchParams = Promise<{ page?: string | string[] }>;

export default async function PerfumesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const requested = parsePageParam(sp.page);

  const db = getDb();
  const total = await countPerfumes(db);
  const { page, offset, limit, totalPages } = resolvePage(
    requested,
    total,
    PAGE_SIZE,
  );

  // Issue #171: if the raw query param doesn't match the canonical form
  // for the clamped page, redirect so the URL bar matches what the
  // viewer is actually seeing. `?page=99999` → `/perfumes?page=<last>`,
  // `?page=abc` / `?page=-1` / `?page=0` / `?page=1` → `/perfumes`.
  const canonicalPageParam = page === 1 ? null : String(page);
  const rawPageParam =
    typeof sp.page === "string"
      ? sp.page
      : Array.isArray(sp.page)
        ? (sp.page[0] ?? null)
        : null;
  if (rawPageParam !== canonicalPageParam) {
    redirect(canonicalPageParam ? `/perfumes?page=${canonicalPageParam}` : "/perfumes");
  }

  const perfumes =
    total === 0 ? [] : await getRecentPerfumes(db, { limit, offset });

  return (
    <div className="space-y-8">
      <header>
        <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
          Browse
        </div>
        <h1 className="mt-1 text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          All perfumes
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {total === 0
            ? "Nothing indexed yet."
            : `${total} perfume${total === 1 ? "" : "s"} in the catalog, newest first.`}
        </p>
      </header>

      {total === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          No perfumes have been indexed yet. Check back soon.
        </div>
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {perfumes.map((p) => (
              <li key={p.uri}>
                <PerfumeTile perfume={p} />
              </li>
            ))}
          </ul>

          <PaginationControls page={page} totalPages={totalPages} />
        </>
      )}
    </div>
  );
}

function PaginationControls({
  page,
  totalPages,
}: {
  page: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;

  const prevHref = page > 1 ? hrefForPage(page - 1) : null;
  const nextHref = page < totalPages ? hrefForPage(page + 1) : null;

  return (
    <nav
      className="flex items-center justify-between border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800"
      aria-label="Pagination"
    >
      {prevHref ? (
        <Link
          href={prevHref}
          className="text-amber-700 hover:underline dark:text-amber-400"
          rel="prev"
        >
          &larr; Previous
        </Link>
      ) : (
        <span className="text-zinc-400 dark:text-zinc-600">&larr; Previous</span>
      )}
      <span className="text-xs text-zinc-500 dark:text-zinc-500">
        Page {page} of {totalPages}
      </span>
      {nextHref ? (
        <Link
          href={nextHref}
          className="text-amber-700 hover:underline dark:text-amber-400"
          rel="next"
        >
          Next &rarr;
        </Link>
      ) : (
        <span className="text-zinc-400 dark:text-zinc-600">Next &rarr;</span>
      )}
    </nav>
  );
}

// `?page=1` drops back to the canonical `/perfumes` URL so the first
// page has exactly one spelling. Everything else keeps the query
// string explicit.
function hrefForPage(page: number): string {
  return page === 1 ? "/perfumes" : `/perfumes?page=${page}`;
}
