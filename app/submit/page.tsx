/**
 * Perfume-submission composer page (Phase 4.D, issue #69).
 *
 * Server component that gates on sign-in and delegates to
 * `<PerfumeSubmissionComposer>`. No context record to load — this is
 * the one write path that doesn't reference an existing perfume.
 */
import { getSession } from "@/lib/auth/session";
import { PerfumeSubmissionComposer } from "@/components/forms/PerfumeSubmissionComposer";
import { SignInPrompt } from "@/components/SignInPrompt";

export default async function SubmitPerfumePage() {
  const session = await getSession();

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div>
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Submit a perfume
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Curators review submissions and publish the final entry. Either way,
          the submission stays in your account so you can look it up later.
        </p>
      </div>

      {session ? <PerfumeSubmissionComposer /> : <SignInPrompt />}
    </div>
  );
}
