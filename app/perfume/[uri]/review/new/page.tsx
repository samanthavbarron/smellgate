/**
 * Review composer page (Phase 4.D, issue #69).
 *
 * Server component: loads the target perfume for context, gates on
 * sign-in, delegates to the client `<ReviewComposer>`. See
 * `app/perfume/[uri]/shelf/new/page.tsx` header for conventions.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getPerfumeByUri } from "@/lib/db/smellgate-queries";
import { getSession } from "@/lib/auth/session";
import { ReviewComposer } from "@/components/forms/ReviewComposer";
import { SignInPrompt } from "@/components/SignInPrompt";

type Params = Promise<{ uri: string }>;

export default async function WriteReviewPage({
  params,
}: {
  params: Params;
}) {
  const { uri: rawUri } = await params;
  const uri = decodeURIComponent(rawUri);

  const [session, perfume] = await Promise.all([
    getSession(),
    getPerfumeByUri(getDb(), uri),
  ]);
  if (!perfume) notFound();

  const encodedUri = encodeURIComponent(uri);
  const perfumeHref = `/perfume/${encodedUri}`;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div>
        <Link
          href={perfumeHref}
          className="text-xs text-zinc-500 hover:text-amber-700 dark:text-zinc-500 dark:hover:text-amber-400"
        >
          ← Back to {perfume.name}
        </Link>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Write a review
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {perfume.name} · {perfume.house}
        </p>
      </div>

      {session ? (
        <ReviewComposer perfumeUri={uri} redirectTo={perfumeHref} />
      ) : (
        <SignInPrompt />
      )}
    </div>
  );
}
