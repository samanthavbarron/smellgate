/**
 * Scoped 404 UI for `/perfume/[uri]` (issue #123). Next.js renders
 * this automatically when `page.tsx` calls `notFound()`.
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
