/**
 * Perfume detail page (Phase 4.B, issue #67).
 *
 * Server component. Reads directly from the Phase 2.B read cache —
 * `getPerfumeByUri`, `getReviewsForPerfume`, `getDescriptionsForPerfume`,
 * `getCommentsForReview`. No client-side fetching.
 *
 * Route: `/perfume/[uri]` — single dynamic segment. The home page's
 * `PerfumeTile` encodes the AT-URI with `encodeURIComponent`, which
 * encodes `/` as `%2F`. Next.js 16 (Turbopack) does NOT split on the
 * encoded slashes, so the whole thing is one segment. However, it
 * ALSO does not decode the percent-encoding before handing the value
 * to the page — `params.uri` arrives still URL-encoded. We call
 * `decodeURIComponent` ourselves to get the AT-URI back. Verified
 * empirically against Next.js 16.1.1 with the seeded dev cache.
 *
 * Action buttons ("Add to shelf", "Write review", "Write description",
 * "Comment") point at composer routes that DO NOT EXIST YET. Phase 4.D
 * (issue TBD) will build them. For now the links will 404; that is
 * expected and documented in the PR body so nobody has to retrofit
 * links later. Same convention the home-page PerfumeTile already uses.
 *
 * Vote buttons on community descriptions are similarly stubs — the
 * underlying server action (vote write path) is Phase 3 territory and
 * isn't wired to a UI yet. Rendered as disabled-looking `<button>`s
 * with a `title` attribute explaining the stub.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import {
  getPerfumeByUri,
  getReviewsForPerfume,
  getDescriptionsForPerfume,
  getCommentsForReview,
  type DescriptionWithVotes,
} from "@/lib/db/smellgate-queries";
import type {
  SmellgateReviewTable,
  SmellgateCommentTable,
} from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { getAccountHandle } from "@/lib/db/queries";

type Params = Promise<{ uri: string }>;

export default async function PerfumeDetailPage({
  params,
}: {
  params: Params;
}) {
  const { uri: rawUri } = await params;
  // Next.js 16 preserves URL-encoding in dynamic segment params, so
  // we decode here to recover the AT-URI that `PerfumeTile` encoded
  // with `encodeURIComponent`. See header comment.
  const uri = decodeURIComponent(rawUri);

  const db = getDb();
  const [session, perfume] = await Promise.all([
    getSession(),
    getPerfumeByUri(db, uri),
  ]);
  if (!perfume) {
    notFound();
  }

  const [reviews, descriptions] = await Promise.all([
    getReviewsForPerfume(db, uri),
    getDescriptionsForPerfume(db, uri),
  ]);

  // Resolve author handles for everyone displayed on the page. One
  // lookup per unique DID; `getAccountHandle` already falls back to
  // Tap's identity resolver if the account isn't in the local cache.
  const commentsByReview = new Map<string, SmellgateCommentTable[]>();
  await Promise.all(
    reviews.map(async (r) => {
      commentsByReview.set(r.uri, await getCommentsForReview(db, r.uri));
    }),
  );

  const dids = new Set<string>();
  for (const r of reviews) dids.add(r.author_did);
  for (const d of descriptions) dids.add(d.author_did);
  for (const list of commentsByReview.values())
    for (const c of list) dids.add(c.author_did);
  const handles = new Map<string, string | null>();
  await Promise.all(
    Array.from(dids).map(async (did) => {
      handles.set(did, await getAccountHandle(did));
    }),
  );
  const handleFor = (did: string): string => handles.get(did) ?? did;

  const encodedUri = encodeURIComponent(uri);
  const signedIn = !!session;

  return (
    <div className="space-y-12">
      {/* Header block ------------------------------------------------- */}
      <section>
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {perfume.name}
        </h1>
        <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {perfume.house}
          {perfume.creator ? ` · ${perfume.creator}` : ""}
          {perfume.release_year ? ` · ${perfume.release_year}` : ""}
        </div>

        {perfume.notes.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {perfume.notes.map((note) => (
              <Link
                key={note}
                href={`/tag/note/${encodeURIComponent(note)}`}
                className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 transition-colors hover:bg-amber-100 hover:text-amber-800 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-amber-950/60 dark:hover:text-amber-300"
              >
                {note}
              </Link>
            ))}
          </div>
        )}

        {perfume.description && (
          <p className="mt-6 max-w-3xl text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            {perfume.description}
          </p>
        )}

        {/* Quick links to house / creator tag pages */}
        <div className="mt-4 flex flex-wrap gap-4 text-xs text-zinc-500 dark:text-zinc-500">
          <Link
            href={`/tag/house/${encodeURIComponent(perfume.house)}`}
            className="hover:text-amber-700 dark:hover:text-amber-400"
          >
            More from {perfume.house}
          </Link>
          {perfume.creator && (
            <Link
              href={`/tag/creator/${encodeURIComponent(perfume.creator)}`}
              className="hover:text-amber-700 dark:hover:text-amber-400"
            >
              More by {perfume.creator}
            </Link>
          )}
        </div>

        {/* Action buttons ---------------------------------------------- */}
        <div className="mt-6 flex flex-wrap gap-2">
          {signedIn ? (
            <>
              <ActionLink href={`/perfume/${encodedUri}/shelf/new`}>
                Add to shelf
              </ActionLink>
              <ActionLink href={`/perfume/${encodedUri}/review/new`}>
                Write review
              </ActionLink>
              <ActionLink href={`/perfume/${encodedUri}/description/new`}>
                Write description
              </ActionLink>
            </>
          ) : (
            <Link
              href="/oauth/login"
              className="rounded-md border border-amber-600 px-3 py-1.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 dark:border-amber-500 dark:text-amber-400 dark:hover:bg-amber-950/40"
            >
              Sign in to add, review, or describe
            </Link>
          )}
        </div>
      </section>

      {/* Reviews ----------------------------------------------------- */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Reviews
          </h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            {reviews.length === 0
              ? "none yet"
              : `${reviews.length} total`}
          </span>
        </div>
        {reviews.length === 0 ? (
          <EmptyState>No reviews yet. Write the first one.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {reviews.map((review) => (
              <li key={review.uri}>
                <ReviewCard
                  review={review}
                  authorHandle={handleFor(review.author_did)}
                  comments={commentsByReview.get(review.uri) ?? []}
                  handleFor={handleFor}
                  signedIn={signedIn}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Community descriptions --------------------------------------- */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Community descriptions
          </h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            {descriptions.length === 0
              ? "none yet"
              : `${descriptions.length} total`}
          </span>
        </div>
        {descriptions.length === 0 ? (
          <EmptyState>
            No community descriptions yet. Write the first one.
          </EmptyState>
        ) : (
          <ul className="space-y-4">
            {descriptions.map((d) => (
              <li key={d.uri}>
                <DescriptionCard
                  description={d}
                  authorHandle={handleFor(d.author_did)}
                  signedIn={signedIn}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ActionLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:border-amber-600 hover:text-amber-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-amber-500 dark:hover:text-amber-400"
    >
      {children}
    </Link>
  );
}

function ReviewCard({
  review,
  authorHandle,
  comments,
  handleFor,
  signedIn,
}: {
  review: SmellgateReviewTable;
  authorHandle: string;
  comments: SmellgateCommentTable[];
  handleFor: (did: string) => string;
  signedIn: boolean;
}) {
  const encodedReviewUri = encodeURIComponent(review.uri);
  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            @{authorHandle}
          </div>
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
      <footer className="mt-3 flex items-center justify-between gap-3 text-xs text-zinc-500 dark:text-zinc-500">
        <span>
          {comments.length} {comments.length === 1 ? "comment" : "comments"}
        </span>
        {signedIn && (
          <Link
            href={`/review/${encodedReviewUri}/comment/new`}
            className="rounded-md border border-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-700 transition-colors hover:border-amber-600 hover:text-amber-700 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-amber-500 dark:hover:text-amber-400"
          >
            Comment
          </Link>
        )}
      </footer>
      {comments.length > 0 && (
        <ul className="mt-4 space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          {comments.map((c) => (
            <li key={c.uri} className="text-sm">
              <div className="text-xs text-zinc-500 dark:text-zinc-500">
                @{handleFor(c.author_did)}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
                {c.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function DescriptionCard({
  description,
  authorHandle,
  signedIn,
}: {
  description: DescriptionWithVotes;
  authorHandle: string;
  signedIn: boolean;
}) {
  return (
    <article className="flex gap-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      {/* Score gutter */}
      <div className="flex shrink-0 flex-col items-center gap-0.5 text-xs text-zinc-500 dark:text-zinc-500">
        {signedIn ? (
          // Vote actions are Phase 3 write-path territory; no server
          // action wired to the UI yet. Rendered as stubs so the shape
          // is visible and the PR doesn't bit-rot. See #67 PR body.
          <button
            type="button"
            title="Vote UI is stubbed — wiring lives in Phase 4.D"
            className="rounded hover:text-amber-700 disabled:cursor-not-allowed dark:hover:text-amber-400"
            disabled
          >
            ▲
          </button>
        ) : (
          <span aria-hidden>▲</span>
        )}
        <span
          className={
            description.score > 0
              ? "font-semibold text-amber-700 dark:text-amber-400"
              : "font-semibold text-zinc-700 dark:text-zinc-300"
          }
        >
          {description.score}
        </span>
        {signedIn ? (
          <button
            type="button"
            title="Vote UI is stubbed — wiring lives in Phase 4.D"
            className="rounded hover:text-amber-700 disabled:cursor-not-allowed dark:hover:text-amber-400"
            disabled
          >
            ▼
          </button>
        ) : (
          <span aria-hidden>▼</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-zinc-500 dark:text-zinc-500">
          @{authorHandle} · +{description.up_count} / −{description.down_count}
        </div>
        <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
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
