/**
 * Global 404 UI (issues #170, #186).
 *
 * Renders for any route not served by a scoped `not-found.tsx`:
 * `/nonexistent`, `/tag` (no slug), `/review` (no slug),
 * `/perfume` (no slug), etc. Replaces Next.js's built-in bare 404
 * (which hard-codes its own `font-family` and ignores the site
 * layout's zinc/amber chrome).
 *
 * Next.js renders this *inside* the root layout (so `<SiteHeader>`
 * and the main container still wrap it), but only for *unmatched*
 * routes — i.e. routes where no page component ever runs. When a page
 * matches and later calls `notFound()` (e.g. a bogus `/perfume/<uri>`
 * URI), Next.js 16 emits an `<html id="__next_error__">` empty-body
 * shell instead; the scoped not-found pages work around that by
 * rendering their UI inline from the page component. See the
 * `app/perfume/[uri]/page.tsx` header for the full diagnosis.
 *
 * Pure server component, no client hooks.
 */
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-12">
      <section className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          The link may be stale or mistyped.
        </p>
      </section>

      <div className="mx-auto max-w-2xl rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
        <p className="text-center">
          We couldn&rsquo;t find anything at that URL. You can head back home
          and browse the catalog.
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
