/**
 * Description composer page (Phase 4.D, issue #69).
 *
 * Server component: loads the target perfume for context, gates on
 * sign-in, delegates to the client `<DescriptionComposer>`.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getPerfumeByUri } from "@/lib/db/smellgate-queries";
import { getSession } from "@/lib/auth/session";
import { DescriptionComposer } from "@/components/forms/DescriptionComposer";

type Params = Promise<{ uri: string }>;

export default async function WriteDescriptionPage({
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
          Write a description
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {perfume.name} · {perfume.house}
        </p>
      </div>

      {session ? (
        <DescriptionComposer perfumeUri={uri} redirectTo={perfumeHref} />
      ) : (
        <SignInPrompt next={`${perfumeHref}/description/new`} />
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
