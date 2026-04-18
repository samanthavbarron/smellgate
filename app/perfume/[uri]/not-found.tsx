/**
 * Scoped 404 UI for `/perfume/[uri]` (issue #123).
 *
 * Chose option (a) — scoped `not-found.tsx` — over a global
 * `app/not-found.tsx` because the concrete failure is actionable here
 * (perfume missing from cache vs. malformed URI), and a global fallback
 * can land as a follow-up if other routes need it.
 *
 * Next.js app-router picks this file up automatically when `page.tsx`
 * calls `notFound()`. The root `app/layout.tsx` still wraps the output,
 * so the `<SiteHeader>` chrome that was missing in the bug repro comes
 * back for free.
 *
 * Client component so we can use `usePathname()` to display the raw URI
 * the user tried — helpful when the link is malformed and the user can
 * see at a glance that the URI looks wrong. Visual rhythm matches the
 * empty-state card on `app/page.tsx` (dashed border, muted zinc).
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PERFUME_PATH_PREFIX = "/perfume/";

function extractTriedUri(pathname: string | null): string | null {
  if (!pathname) return null;
  if (!pathname.startsWith(PERFUME_PATH_PREFIX)) return null;
  const encoded = pathname.slice(PERFUME_PATH_PREFIX.length);
  if (!encoded) return null;
  // `page.tsx` decodes with `decodeURIComponent`; mirror that here so
  // the user sees the decoded AT-URI form (e.g. `at://did:plc:.../...`)
  // rather than `%2F`-noise. Fall back to the raw encoded segment if
  // decoding throws (malformed percent-sequences).
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export default function PerfumeNotFound() {
  const pathname = usePathname();
  const triedUri = extractTriedUri(pathname);

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
        {triedUri && (
          <p className="mt-4 break-all text-center font-mono text-xs text-zinc-500 dark:text-zinc-500">
            {triedUri}
          </p>
        )}
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
