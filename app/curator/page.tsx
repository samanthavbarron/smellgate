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
 * Data: reads directly from the Phase 2.B cache via
 * `getPendingSubmissions`, then fans out to
 * `smellgate_perfume_submission_note` for the note chips and to
 * `getAccountHandle` for each submitter. No per-row queries for
 * perfumes — the dashboard only shows submission fields.
 *
 * The duplicate-picker is a plain text input where the curator pastes
 * an AT-URI. Real search integration is deferred to a follow-up on
 * top of Phase 4.F's `searchPerfumes`. See PR body for the follow-up
 * issue link.
 */
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { isCurator } from "@/lib/curators";
import { getPendingSubmissions } from "@/lib/db/smellgate-queries";
import { getAccountHandle } from "@/lib/db/queries";
import type { SmellgatePerfumeSubmissionTable } from "@/lib/db";
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
  const submissions = await getPendingSubmissions(db);

  // Fan out: note chips and submitter handles. Kept as two small
  // round-trips rather than stuffing them into the pending-submissions
  // query so we don't have to touch lib/db/smellgate-queries.ts.
  const notesByUri = await loadNotes(db, submissions);
  const handlesByDid = await loadHandles(submissions);

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
              <SubmissionCard
                submission={{
                  uri: submission.uri,
                  name: submission.name,
                  house: submission.house,
                  creator: submission.creator,
                  releaseYear: submission.release_year,
                  description: submission.description,
                  rationale: submission.rationale,
                  createdAt: submission.created_at,
                  indexedAt: submission.indexed_at,
                  authorDid: submission.author_did,
                  notes: notesByUri.get(submission.uri) ?? [],
                  authorHandle: handlesByDid.get(submission.author_did) ?? null,
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function loadNotes(
  db: ReturnType<typeof getDb>,
  submissions: SmellgatePerfumeSubmissionTable[],
): Promise<Map<string, string[]>> {
  const uris = submissions.map((s) => s.uri);
  if (uris.length === 0) return new Map();
  const rows = await db
    .selectFrom("smellgate_perfume_submission_note")
    .select(["submission_uri", "note"])
    .where("submission_uri", "in", uris)
    .execute();
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const list = out.get(row.submission_uri) ?? [];
    list.push(row.note);
    out.set(row.submission_uri, list);
  }
  return out;
}

async function loadHandles(
  submissions: SmellgatePerfumeSubmissionTable[],
): Promise<Map<string, string | null>> {
  const dids = Array.from(new Set(submissions.map((s) => s.author_did)));
  const entries = await Promise.all(
    dids.map(async (did) => [did, await getAccountHandle(did)] as const),
  );
  return new Map(entries);
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
