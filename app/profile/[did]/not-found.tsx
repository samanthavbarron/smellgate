/**
 * Scoped 404 UI for `/profile/[did]` (issue #176). Exported so the
 * adjacent `page.tsx` can render it inline — see the Next.js 16
 * mid-stream bailout note in `app/perfume/[uri]/page.tsx` for why
 * inline rendering is load-bearing (not `notFound()`).
 */
import Link from "next/link";

export default function ProfileNotFound() {
  return (
    <div className="space-y-12">
      <section className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Profile not found
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          The DID may not yet be indexed here, or the link may be malformed.
        </p>
      </section>

      <div className="mx-auto max-w-2xl rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
        <p className="text-center">
          We don&rsquo;t have any records for this DID yet. It might be a fresh
          account, a typo, or simply not indexed. You can head back home and
          browse what&rsquo;s in the catalog.
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
