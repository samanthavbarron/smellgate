/**
 * Profile page (Phase 4.C, issue #68).
 *
 * Route: `/profile/[did]` — the segment is an `encodeURIComponent`'d
 * ATProto DID (e.g. `did:plc:...`). Next.js 16 preserves URL-encoding
 * in dynamic segment params, so we decode manually here — same
 * reasoning as the perfume detail page. A DID contains `:` but no
 * `/`, so both encoded and plain forms resolve to a single segment.
 *
 * Server component. Reads directly from the Phase 2.B read cache via
 * `getUserShelf`, `getUserReviews`, `getUserDescriptions`. Handle
 * resolution goes through `getAccountHandle`, which already falls
 * back to Tap's identity resolver when the account isn't cached.
 *
 * Layout: stacked sections, not tabs. Justification: tabs would need
 * a client component (or three sub-routes) for no real win on a page
 * where all three sections are cheap to render and each has its own
 * empty state. Stacked matches the perfume detail page's rhythm.
 *
 * Review rendering: option (c) from the issue body. On a profile the
 * user is the context, so each review / description header shows
 * "Review of <perfume name>" linking to the perfume, rather than the
 * author handle the perfume detail page leads with. This is enough
 * visual divergence from the perfume page's `ReviewCard` that
 * extracting a shared component would be premature — the markup
 * reads differently in the two contexts. Same for descriptions. Per
 * docs/ui.md: "If a pattern ends up repeated in enough places that
 * extracting it would save meaningful code, extract it at that
 * point — not preemptively."
 *
 * Not-found behavior: if all three lists are empty AND the identity
 * resolver returns no handle, we call `notFound()`. Any signal of
 * existence (a handle, or any cached record) is enough to render the
 * page — an empty but real profile is valid.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import {
  getUserShelf,
  getUserReviews,
  getUserDescriptions,
  type ShelfItemWithPerfume,
  type DescriptionWithVotes,
} from "@/lib/db/smellgate-queries";
import type { SmellgateReviewTable } from "@/lib/db";
import { getAccountHandle } from "@/lib/db/queries";
import { getSession } from "@/lib/auth/session";
import { PerfumeTile } from "@/components/PerfumeTile";

type Params = Promise<{ did: string }>;

export default async function ProfilePage({ params }: { params: Params }) {
  const { did: rawDid } = await params;
  const did = decodeURIComponent(rawDid);

  const db = getDb();
  const [session, handle, shelf, reviews, descriptions] = await Promise.all([
    getSession(),
    getAccountHandle(did),
    getUserShelf(db, did),
    getUserReviews(db, did),
    getUserDescriptions(db, did),
  ]);
  // Issue #131 reviewer follow-up: when the signed-in user is looking
  // at their own profile, surface a link to /profile/me/submissions.
  // Own-profile detection is the same (session.did === did) check used
  // elsewhere; no extra round-trip.
  const isSelf = session?.did === did;

  // An authenticated user viewing their own profile is always a valid
  // state — a freshly-logged-in user with no records, or any user when
  // the identity cache is empty (e.g. no Tap consumer attached yet),
  // should still see their own profile render. The 404 only makes
  // sense for foreign DIDs we have no signal for.
  if (
    !isSelf &&
    !handle &&
    shelf.length === 0 &&
    reviews.length === 0 &&
    descriptions.length === 0
  ) {
    notFound();
  }

  // For reviews and descriptions we need the perfume name / house
  // alongside each item so the header can read "Review of <name>".
  // `getUserShelf` already joins the perfume; `getUserReviews` and
  // `getUserDescriptions` do not, so we do a single round-trip here.
  const perfumeUris = Array.from(
    new Set([
      ...reviews.map((r) => r.perfume_uri),
      ...descriptions.map((d) => d.perfume_uri),
    ]),
  );
  const perfumeRows =
    perfumeUris.length === 0
      ? []
      : await db
          .selectFrom("smellgate_perfume")
          .select(["uri", "name", "house"])
          .where("uri", "in", perfumeUris)
          .execute();
  const perfumeByUri = new Map(perfumeRows.map((p) => [p.uri, p]));

  return (
    <div className="space-y-12">
      {/* Header ------------------------------------------------------ */}
      <section>
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {handle ? `@${handle}` : "Unknown handle"}
        </h1>
        <div className="mt-2 break-all font-mono text-xs text-zinc-500 dark:text-zinc-500">
          {did}
        </div>
        {isSelf && (
          <div className="mt-3">
            <Link
              href="/profile/me/submissions"
              className="text-sm text-amber-700 underline hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
            >
              My submissions →
            </Link>
          </div>
        )}
      </section>

      {/* Shelf ------------------------------------------------------- */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Shelf
          </h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            {shelf.length === 0 ? "nothing on shelf" : `${shelf.length} total`}
          </span>
        </div>
        {shelf.length === 0 ? (
          <EmptyState>No perfumes on shelf yet.</EmptyState>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shelf.map((item) => (
              <li key={item.uri}>
                <ShelfCard item={item} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Reviews ----------------------------------------------------- */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Reviews
          </h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            {reviews.length === 0 ? "none yet" : `${reviews.length} total`}
          </span>
        </div>
        {reviews.length === 0 ? (
          <EmptyState>No reviews yet.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {reviews.map((review) => (
              <li key={review.uri}>
                <ProfileReviewCard
                  review={review}
                  perfume={perfumeByUri.get(review.perfume_uri) ?? null}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Descriptions ------------------------------------------------ */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Descriptions
          </h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            {descriptions.length === 0
              ? "none yet"
              : `${descriptions.length} total`}
          </span>
        </div>
        {descriptions.length === 0 ? (
          <EmptyState>No community descriptions yet.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {descriptions.map((d) => (
              <li key={d.uri}>
                <ProfileDescriptionCard
                  description={d}
                  perfume={perfumeByUri.get(d.perfume_uri) ?? null}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ShelfCard({ item }: { item: ShelfItemWithPerfume }) {
  const meta: string[] = [];
  if (item.acquired_at) {
    // `acquired_at` is an ISO date string per the lexicon; show the
    // date portion only so we don't have to worry about timezones.
    meta.push(`acquired ${item.acquired_at.slice(0, 10)}`);
  }
  if (item.bottle_size_ml != null) {
    meta.push(`${item.bottle_size_ml} ml`);
  }
  if (item.is_decant) {
    meta.push("decant");
  }
  return (
    <div className="flex h-full flex-col gap-2">
      {item.perfume ? (
        <PerfumeTile perfume={item.perfume} />
      ) : (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          Perfume not yet indexed
        </div>
      )}
      {meta.length > 0 && (
        <div className="px-1 text-xs text-zinc-500 dark:text-zinc-500">
          {meta.join(" · ")}
        </div>
      )}
    </div>
  );
}

function ProfileReviewCard({
  review,
  perfume,
}: {
  review: SmellgateReviewTable;
  perfume: { uri: string; name: string; house: string } | null;
}) {
  const href = perfume
    ? `/perfume/${encodeURIComponent(perfume.uri)}`
    : null;
  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Review of{" "}
            {href ? (
              <Link
                href={href}
                className="hover:text-amber-700 dark:hover:text-amber-400"
              >
                {perfume!.name}
              </Link>
            ) : (
              <span className="text-zinc-500 dark:text-zinc-500">
                unknown perfume
              </span>
            )}
          </div>
          {perfume && (
            <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {perfume.house}
            </div>
          )}
          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
            sillage {review.sillage}/5 · longevity {review.longevity}/5
          </div>
        </div>
        <div className="shrink-0 text-xl font-semibold text-amber-700 dark:text-amber-400">
          {review.rating}/10
        </div>
      </header>
      <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
        {review.body}
      </p>
    </article>
  );
}

function ProfileDescriptionCard({
  description,
  perfume,
}: {
  description: DescriptionWithVotes;
  perfume: { uri: string; name: string; house: string } | null;
}) {
  const href = perfume
    ? `/perfume/${encodeURIComponent(perfume.uri)}`
    : null;
  return (
    <article className="flex gap-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      {/* Score label — profile descriptions are a feed of the user's
          own writing, not a voting surface, so we render a plain
          "Score: N" label instead of the perfume detail page's
          ▲/▼ gutter (which visually suggests buttons). See #78. */}
      <div className="flex shrink-0 flex-col items-start gap-0.5 text-xs text-zinc-500 dark:text-zinc-500">
        <span>
          Score:{" "}
          <span
            className={
              description.score > 0
                ? "font-semibold text-amber-700 dark:text-amber-400"
                : "font-semibold text-zinc-700 dark:text-zinc-300"
            }
          >
            {description.score}
          </span>
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Description of{" "}
          {href ? (
            <Link
              href={href}
              className="hover:text-amber-700 dark:hover:text-amber-400"
            >
              {perfume!.name}
            </Link>
          ) : (
            <span className="text-zinc-500 dark:text-zinc-500">
              unknown perfume
            </span>
          )}
        </div>
        {perfume && (
          <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {perfume.house}
          </div>
        )}
        <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          +{description.up_count} / −{description.down_count}
        </div>
        <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
          {description.body}
        </p>
      </div>
    </article>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
      {children}
    </div>
  );
}
