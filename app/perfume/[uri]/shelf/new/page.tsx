/**
 * Add-to-shelf composer page (Phase 4.D, issue #69).
 *
 * Server component: loads the target perfume from the read cache so
 * we can show it as context in the page header, gates on sign-in,
 * then hands off to the client `<ShelfComposer>` which does the POST
 * to `/api/smellgate/shelf`.
 *
 * See AGENTS.md header comment in `app/perfume/[uri]/page.tsx` for
 * the Next.js 16 dynamic-segment decoding behavior.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getPerfumeByUri } from "@/lib/db/smellgate-queries";
import { getSession } from "@/lib/auth/session";
import { ShelfComposer } from "@/components/forms/ShelfComposer";

type Params = Promise<{ uri: string }>;

export default async function AddToShelfPage({ params }: { params: Params }) {
  const { uri: rawUri } = await params;
  const uri = decodeURIComponent(rawUri);

  const [session, perfume] = await Promise.all([
    getSession(),
    getPerfumeByUri(getDb(), uri),
  ]);
  if (!perfume) notFound();

  const encodedUri = encodeURIComponent(uri);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div>
        <Link
          href={`/perfume/${encodedUri}`}
          className="text-xs text-zinc-500 hover:text-amber-700 dark:text-zinc-500 dark:hover:text-amber-400"
        >
          ← Back to {perfume.name}
        </Link>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Add to shelf
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {perfume.name} · {perfume.house}
        </p>
      </div>

      {session ? (
        <ShelfComposer perfumeUri={uri} />
      ) : (
        <SignInPrompt next={`/perfume/${encodedUri}/shelf/new`} />
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
