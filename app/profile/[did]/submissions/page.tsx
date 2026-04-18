/**
 * Public submissions list for a given DID (issue #173).
 *
 * Route: `/profile/[did]/submissions` — server component, anonymous
 * access. Lists all `app.smellgate.perfumeSubmission` records authored
 * by the DID, annotated with resolution state. Mirrors the layout of
 * `/profile/me/submissions` but reads from the smellgate cache
 * instead of the user's PDS — we can't list a foreign PDS without
 * their OAuth session.
 *
 * Cache-lag caveat: a submission written in the last few seconds may
 * briefly be absent. Acceptable for a public view; self-viewers who
 * want the authoritative live list can use `/profile/me/submissions`,
 * which still hits the PDS directly.
 *
 * Empty state: shows the usual "No submissions yet" card rather than
 * 404. A user who hasn't submitted anything has no cached rows, and
 * the page is still a legitimate URL for them.
 */
import Link from "next/link";
import { getDb } from "@/lib/db";
import {
  groupSubmissionsByState,
  listSubmissionsForDidAction,
  type MySubmissionItem,
  type SubmissionState,
} from "@/lib/server/smellgate-actions";
import { getAccountHandle } from "@/lib/db/queries";

type Params = Promise<{ did: string }>;

export default async function ProfileSubmissionsPage({
  params,
}: {
  params: Params;
}) {
  const { did: rawDid } = await params;
  const did = decodeURIComponent(rawDid);
  const db = getDb();
  const [items, handle] = await Promise.all([
    listSubmissionsForDidAction(db, did),
    getAccountHandle(did),
  ]);
  const grouped = groupSubmissionsByState(items);

  return (
    <div className="space-y-12">
      <section>
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {handle ? `@${handle}` : "Profile"}{" "}
          <span className="text-zinc-400 dark:text-zinc-500">·</span> submissions
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Perfumes this account has proposed for the canonical catalog. A
          submission written in the last few seconds may not appear here until
          the firehose catches up.
        </p>
        <div className="mt-3 break-all font-mono text-xs text-zinc-500 dark:text-zinc-500">
          {did}
        </div>
        <div className="mt-3">
          <Link
            href={`/profile/${encodeURIComponent(did)}`}
            className="text-sm text-amber-700 underline hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
          >
            ← Back to profile
          </Link>
        </div>
      </section>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          No submissions yet.
        </div>
      ) : (
        <>
          <SubmissionSection state="pending" items={grouped.pending} />
          <SubmissionSection state="approved" items={grouped.approved} />
          <SubmissionSection state="duplicate" items={grouped.duplicate} />
          <SubmissionSection state="rejected" items={grouped.rejected} />
        </>
      )}
    </div>
  );
}

const STATE_LABEL: Record<SubmissionState, string> = {
  pending: "Pending curator review",
  approved: "Approved",
  rejected: "Rejected",
  duplicate: "Marked as duplicate",
};

function SubmissionSection({
  state,
  items,
}: {
  state: SubmissionState;
  items: MySubmissionItem[];
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
        {STATE_LABEL[state]}{" "}
        <span className="text-sm font-normal text-zinc-500 dark:text-zinc-500">
          ({items.length})
        </span>
      </h2>
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item.uri}>
            <SubmissionRow item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatSubmittedAt(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return createdAt;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function SubmissionRow({ item }: { item: MySubmissionItem }) {
  return (
    <article
      data-smellgate-submission={item.uri}
      data-state={item.state}
      className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <header className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {item.name}
          </h3>
          <div className="truncate text-xs text-zinc-600 dark:text-zinc-400">
            {item.house}
            {item.creator ? ` · ${item.creator}` : null}
            {item.releaseYear ? ` · ${item.releaseYear}` : null}
          </div>
          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
            Submitted {formatSubmittedAt(item.createdAt)}
          </div>
        </div>
        <StateChip state={item.state} />
      </header>

      {item.notes.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {item.notes.map((note) => (
            <li
              key={note}
              className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
            >
              {note}
            </li>
          ))}
        </ul>
      )}

      {item.state === "approved" && item.resolvedPerfumeUri && (
        <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          <Link
            href={`/perfume/${encodeURIComponent(item.resolvedPerfumeUri)}`}
            className="underline hover:text-amber-700 dark:hover:text-amber-400"
          >
            View canonical perfume →
          </Link>
        </div>
      )}

      {item.state === "duplicate" && item.resolvedPerfumeUri && (
        <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Matched to{" "}
          <Link
            href={`/perfume/${encodeURIComponent(item.resolvedPerfumeUri)}`}
            className="underline hover:text-amber-700 dark:hover:text-amber-400"
          >
            an existing perfume →
          </Link>
        </div>
      )}

      {item.state === "rejected" && item.resolutionNote && (
        <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          <span className="font-medium">Curator note:</span>{" "}
          {item.resolutionNote}
        </div>
      )}

      <div className="mt-2 break-all font-mono text-xs text-zinc-500 dark:text-zinc-500">
        {item.uri}
      </div>
    </article>
  );
}

function StateChip({ state }: { state: SubmissionState }) {
  const cls =
    state === "pending"
      ? "border-amber-600 bg-amber-50 text-amber-800 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-200"
      : "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300";
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}
