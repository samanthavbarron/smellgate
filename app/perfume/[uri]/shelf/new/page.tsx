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
import { SignInPrompt } from "@/components/SignInPrompt";

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

      {session ? <ShelfComposer perfumeUri={uri} /> : <SignInPrompt />}
    </div>
  );
}
