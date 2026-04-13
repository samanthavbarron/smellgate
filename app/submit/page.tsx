/**
 * Perfume-submission composer page (Phase 4.D, issue #69).
 *
 * Server component that gates on sign-in and delegates to
 * `<PerfumeSubmissionComposer>`. No context record to load — this is
 * the one write path that doesn't reference an existing perfume.
 */
import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { PerfumeSubmissionComposer } from "@/components/forms/PerfumeSubmissionComposer";

export default async function SubmitPerfumePage() {
  const session = await getSession();

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div>
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Submit a perfume
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Curators review submissions and publish canonical records.
          Your submission lives in your repo either way.
        </p>
      </div>

      {session ? (
        <PerfumeSubmissionComposer />
      ) : (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          <p>You need to sign in first.</p>
          <Link
            href={`/oauth/login?next=${encodeURIComponent("/submit")}`}
            className="mt-3 inline-block rounded-md border border-amber-600 px-3 py-1.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 dark:border-amber-500 dark:text-amber-400 dark:hover:bg-amber-950/40"
          >
            Sign in
          </Link>
        </div>
      )}
    </div>
  );
}
