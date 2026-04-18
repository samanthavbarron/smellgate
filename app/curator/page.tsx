/**
 * Curator dashboard (Phase 4.E, issue #70).
 *
 * Server component. Three branches:
 *   1. Not signed in → 403 card with "Sign in as a curator".
 *   2. Signed in but not a curator → 403 card with "You are not a curator".
 *   3. Signed in + curator → the dashboard: list of pending
 *      `perfumeSubmission` records, each wrapped in a client-side
 *      `<SubmissionCard>` that POSTs to the Phase 3.C curator API
 *      routes at `/api/smellgate/curator/{approve,reject,duplicate}`.
 *
 * Data: issue #140 moved the `notes` + `authorHandle` fan-out into
 * `listPendingSubmissionsAction` so the SSR page and the JSON API
 * return the same decorated shape. We consume the decorated value
 * here and hand it straight to `<SubmissionCard>`.
 *
 * The duplicate-picker inline typeahead (issue #139) lives inside
 * `<SubmissionCard>` — on mode enter it fetches top-5 canonical
 * candidates from `/api/smellgate/curator/search` and renders them as
 * clickable rows above the hand-paste URI input.
 */
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { isCurator } from "@/lib/curators";
import { listPendingSubmissionsAction } from "@/lib/server/smellgate-curator-actions";
import { SubmissionCard } from "@/components/curator/SubmissionCard";

export default async function CuratorPage() {
  const session = await getSession();

  if (!session) {
    return (
      <ForbiddenCard
        title="Sign in as a curator"
        body="The curator dashboard is only accessible to signed-in curator accounts."
      />
    );
  }

  if (!isCurator(session.did)) {
    return (
      <ForbiddenCard
        title="You are not a curator"
        body="Your signed-in account is not on the configured curator list."
      />
    );
  }

  const db = getDb();
  const { submissions } = await listPendingSubmissionsAction(db, session);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Curator Dashboard
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Pending perfume submissions awaiting review. Oldest first.
        </p>
      </section>

      {submissions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          No submissions awaiting review.
        </div>
      ) : (
        <ul className="space-y-4">
          {submissions.map((submission) => (
            <li key={submission.uri}>
              <SubmissionCard submission={submission} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ForbiddenCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
        {title}
      </h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{body}</p>
    </div>
  );
}
