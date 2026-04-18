/**
 * My submissions page (issue #131).
 *
 * Route: `/profile/me/submissions` — server component. Lists the
 * authenticated user's own `app.smellgate.perfumeSubmission` records,
 * read live from their PDS (not the app cache), annotated with
 * resolution state (`pending` / `approved` / `rejected` / `duplicate`).
 *
 * Unauth behavior: redirect to the sign-in anchor on the home page,
 * matching what `app/profile/me/page.tsx` already does for the DID
 * redirect route. The OAuth login endpoint itself is POST-only, so we
 * send the visitor to `/#sign-in` where the header's sign-in form
 * picks them up.
 *
 * Data shape: `listMySubmissionsAction` fetches from the user's PDS
 * via the lex client's `list(app.smellgate.perfumeSubmission.main)`,
 * then cross-references each record against the cached
 * `smellgate_perfume_submission_resolution` table. See the action for
 * the cache-lag note: a fresh approval may show as `pending` until
 * the firehose catches up, which is documented as acceptable.
 *
 * Layout follows docs/ui.md: stacked sections (pending / approved /
 * rejected / duplicate), zinc neutrals, amber accent for the state
 * chip. No new primitives — plain Tailwind inline.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  groupSubmissionsByState,
  listMySubmissionsAction,
  type MySubmissionItem,
  type SubmissionState,
} from "@/lib/server/smellgate-actions";

export default async function MySubmissionsPage() {
  const session = await getSession();
  if (!session) {
    redirect("/#sign-in");
  }

  const db = getDb();
  const items = await listMySubmissionsAction(db, session);
  const grouped = groupSubmissionsByState(items);

  return (
    <div className="space-y-12">
      <section>
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          My submissions
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Perfumes you have proposed for the canonical catalog. Resolution
          state is read from the cached resolution records — a very fresh
          approval may briefly show as pending.
        </p>
      </section>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          You have not submitted any perfumes yet.{" "}
          <Link
            href="/submit"
            className="underline hover:text-amber-700 dark:hover:text-amber-400"
          >
            Submit a perfume →
          </Link>
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
  // ISO with seconds, UTC — matches the breadcrumb format on the
  // curator card. Avoids a locale-dependent display that would make
  // the page non-deterministic in tests.
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
  // Pending uses the amber accent (the one action needed from the
  // curator). Approved/duplicate use zinc-subdued (resolved, neutral
  // outcome). Rejected uses zinc too — we do not introduce a red
  // accent, per docs/ui.md's one-accent-color rule.
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
