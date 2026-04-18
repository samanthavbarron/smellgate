/**
 * Scoped 404 UI for `/perfume/[uri]` (issue #123). Exported so the
 * adjacent `page.tsx` can render it inline when the perfume URI
 * doesn't resolve — see the Next.js 16 mid-stream bailout note in
 * `page.tsx` for why inline rendering is load-bearing here (not
 * `notFound()`).
 *
 * Also registered as Next.js's scoped `not-found.tsx` at this segment
 * so any future `notFound()` call from a deeper child (e.g. the
 * composer routes under `/perfume/[uri]/review/new`) picks this up
 * rather than the global `app/not-found.tsx`. Those cases currently
 * fall back to the global because the matching pages don't call
 * `notFound()` themselves.
 */
import Link from "next/link";

export default function PerfumeNotFound() {
  return (
    <div className="space-y-12">
      <section className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Perfume not found
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          It may not yet be in the catalog, or the link may be malformed.
        </p>
      </section>

      <div className="mx-auto max-w-2xl rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
        <p className="text-center">
          The firehose may not have indexed this one yet, or the URI may be
          wrong. You can head back home and browse what&rsquo;s in the catalog.
        </p>
        <div className="mt-6 text-center">
          <Link
            href="/"
            className="text-amber-700 hover:underline dark:text-amber-400"
          >
            Back to home &rarr;
          </Link>
        </div>
      </div>
    </div>
  );
}
