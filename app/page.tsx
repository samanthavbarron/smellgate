/**
 * Home page (Phase 4.A).
 *
 * Server component. Reads directly from the Phase 2.B read cache via
 * `getRecentPerfumes` / `getRecentReviews`. No client-side fetching.
 *
 * Tiles link to `/perfume/<encoded uri>` even though that route does
 * not exist yet — Phase 4.B builds it. The link will 404 for now; that
 * is expected and intentional so we don't have to retrofit links later.
 */
import Link from "next/link";
import { getDb } from "@/lib/db";
import {
  getRecentPerfumes,
  getRecentReviews,
  type ReviewWithPerfume,
} from "@/lib/db/smellgate-queries";
import { getSession } from "@/lib/auth/session";
import { LoginForm } from "@/components/LoginForm";
import { PerfumeTile } from "@/components/PerfumeTile";

export default async function Home() {
  const db = getDb();
  const [session, perfumes, reviews] = await Promise.all([
    getSession(),
    getRecentPerfumes(db, { limit: 12 }),
    getRecentReviews(db, { limit: 6 }),
  ]);

  return (
    <div className="space-y-12">
      <section className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          smellgate
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Letterboxd for perfume. Built on ATProto.
        </p>
      </section>

      <div
        role="note"
        className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
      >
        <strong className="font-medium">Synthetic catalog.</strong> The perfumes
        shown here are a fictional seed catalog for development. Nothing in this
        list exists in real life — names, houses, creators, and notes are all
        invented.
      </div>

      {!session && (
        <section
          id="sign-in"
          className="mx-auto max-w-md rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h2 className="mb-3 text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Sign in with your ATProto handle
          </h2>
          <LoginForm />
        </section>
      )}

      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Recent perfumes
          </h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            {perfumes.length === 0
              ? "nothing indexed yet"
              : `${perfumes.length} shown`}
          </span>
        </div>
        {perfumes.length === 0 ? (
          <EmptyState>
            The cache is empty. Seed it with{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">
              pnpm dev:seed-cache
            </code>
            , or wait for the firehose dispatcher to index your first records.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {perfumes.map((p) => (
              <li key={p.uri}>
                <PerfumeTile perfume={p} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Recent reviews
          </h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            {reviews.length === 0 ? "no reviews yet" : `${reviews.length} shown`}
          </span>
        </div>
        {reviews.length === 0 ? (
          <EmptyState>
            Nobody has posted a review yet. Reviews live in users&rsquo; PDSs and
            are indexed into the local cache when the firehose sees them.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {reviews.map((r) => (
              <li key={r.uri}>
                <ReviewRow review={r} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ReviewRow({ review }: { review: ReviewWithPerfume }) {
  const href = review.perfume
    ? `/perfume/${encodeURIComponent(review.perfume.uri)}`
    : "#";
  const snippet =
    review.body.length > 200 ? `${review.body.slice(0, 200).trimEnd()}…` : review.body;
  return (
    <Link
      href={href}
      className="block rounded-lg border border-zinc-200 bg-white p-4 transition-colors hover:border-amber-600 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-amber-500"
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {review.perfume?.name ?? "unknown perfume"}
          </div>
          {review.perfume && (
            <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {review.perfume.house}
            </div>
          )}
        </div>
        <div className="shrink-0 text-sm font-semibold text-amber-700 dark:text-amber-400">
          {review.rating}/10
        </div>
      </div>
      {snippet && (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{snippet}</p>
      )}
    </Link>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
      {children}
    </div>
  );
}
