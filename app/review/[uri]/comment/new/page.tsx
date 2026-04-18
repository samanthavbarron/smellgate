/**
 * Comment composer page (Phase 4.D, issue #69).
 *
 * Server component for writing a flat reply on a
 * `app.smellgate.review`. The URL segment is the review's AT-URI,
 * URL-encoded (same convention as `/perfume/[uri]`).
 *
 * We load the review row via `getReviewByUri` to recover its parent
 * `perfume_uri`, then load that perfume for the context header and
 * as the redirect target on successful post.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import {
  getPerfumeByUri,
  getReviewByUri,
} from "@/lib/db/smellgate-queries";
import { getSession } from "@/lib/auth/session";
import { CommentComposer } from "@/components/forms/CommentComposer";

type Params = Promise<{ uri: string }>;

export default async function WriteCommentPage({
  params,
}: {
  params: Params;
}) {
  const { uri: rawUri } = await params;
  const reviewUri = decodeURIComponent(rawUri);

  const db = getDb();
  const session = await getSession();
  const reviewRow = await getReviewByUri(db, reviewUri);
  if (!reviewRow) notFound();

  const perfume = await getPerfumeByUri(db, reviewRow.perfume_uri);
  const perfumeHref = perfume
    ? `/perfume/${encodeURIComponent(perfume.uri)}`
    : "/";

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div>
        {perfume && (
          <Link
            href={perfumeHref}
            className="text-xs text-zinc-500 hover:text-amber-700 dark:text-zinc-500 dark:hover:text-amber-400"
          >
            ← Back to {perfume.name}
          </Link>
        )}
        <h1 className="mt-2 text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Reply to review
        </h1>
        {perfume && (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            {perfume.name} · {perfume.house}
          </p>
        )}
      </div>

      {session ? (
        <CommentComposer reviewUri={reviewUri} redirectTo={perfumeHref} />
      ) : (
        <SignInPrompt
          next={`/review/${encodeURIComponent(reviewUri)}/comment/new`}
        />
      )}
    </div>
  );
}

function SignInPrompt({ next }: { next: string }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
      <p>You need to sign in first.</p>
      <Link
        href={`/oauth/login?next=${encodeURIComponent(next)}`}
        className="mt-3 inline-block rounded-md border border-amber-600 px-3 py-1.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 dark:border-amber-500 dark:text-amber-400 dark:hover:bg-amber-950/40"
      >
        Sign in
      </Link>
    </div>
  );
}
