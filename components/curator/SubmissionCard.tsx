"use client";

/**
 * Curator dashboard submission card (Phase 4.E, issue #70).
 *
 * Client component because the three action buttons need local state
 * (pending/error) and a couple of inline expanders for the reject
 * note + the duplicate canonical URI. Intentionally no modal library:
 * the "reject" and "mark duplicate" flows use a conditional inline
 * block directly under the action row. Per docs/ui.md + hard
 * constraints in the issue, no new dependencies.
 *
 * The duplicate picker is a plain text input where the curator pastes
 * an AT-URI. Real search-powered picking is deferred: Phase 4.F's
 * `searchPerfumes` query is landing in parallel, and a follow-up
 * issue will wire it in.
 *
 * Issue #137: after a successful action, the card renders an inline
 * confirmation block instead of silently vanishing on `router.refresh()`.
 * For approve, we surface the new canonical perfume URI as a click-
 * through link so the curator can verify it landed correctly. For
 * reject/duplicate we surface the resolution URI as a copyable
 * breadcrumb. The confirmation persists until the curator dismisses
 * it — deliberately NOT auto-hidden on refresh, so a curator who
 * blinked doesn't lose the reference.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface SubmissionCardData {
  uri: string;
  name: string;
  house: string;
  creator: string | null;
  releaseYear: number | null;
  description: string | null;
  rationale: string | null;
  createdAt: string;
  indexedAt: number;
  authorDid: string;
  notes: string[];
  authorHandle: string | null;
}

type Mode = "idle" | "reject" | "duplicate";

interface ApproveConfirmation {
  kind: "approved";
  perfumeUri: string;
  resolutionUri: string;
}
interface ResolutionConfirmation {
  kind: "rejected" | "duplicate";
  resolutionUri: string;
}
type Confirmation = ApproveConfirmation | ResolutionConfirmation;

export function SubmissionCard({
  submission,
}: {
  submission: SubmissionCardData;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [canonicalUri, setCanonicalUri] = useState("");

  async function post<T extends Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T | null> {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: T & { error?: string } = await res
        .json()
        .catch(() => ({}) as T & { error?: string });
      if (!res.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return null;
      }
      setMode("idle");
      // Keep the confirmation visible: intentionally NOT calling
      // router.refresh() here. The curator dismisses the banner; on
      // dismissal we refresh so the card drops out of the list.
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
      return null;
    } finally {
      setPending(false);
    }
  }

  async function onApprove() {
    const data = await post<{ perfumeUri?: string; resolutionUri?: string }>(
      "/api/smellgate/curator/approve",
      { submissionUri: submission.uri },
    );
    if (data && typeof data.perfumeUri === "string" && typeof data.resolutionUri === "string") {
      setConfirmation({
        kind: "approved",
        perfumeUri: data.perfumeUri,
        resolutionUri: data.resolutionUri,
      });
    }
  }

  async function onReject() {
    const note = rejectNote.trim();
    const data = await post<{ resolutionUri?: string }>(
      "/api/smellgate/curator/reject",
      {
        submissionUri: submission.uri,
        ...(note.length > 0 ? { note } : {}),
      },
    );
    if (data && typeof data.resolutionUri === "string") {
      setConfirmation({ kind: "rejected", resolutionUri: data.resolutionUri });
    }
  }

  async function onDuplicate() {
    const canonical = canonicalUri.trim();
    if (canonical.length === 0) {
      setError("canonical perfume AT-URI is required");
      return;
    }
    const data = await post<{ resolutionUri?: string }>(
      "/api/smellgate/curator/duplicate",
      { submissionUri: submission.uri, canonicalPerfumeUri: canonical },
    );
    if (data && typeof data.resolutionUri === "string") {
      setConfirmation({ kind: "duplicate", resolutionUri: data.resolutionUri });
    }
  }

  function dismissConfirmation() {
    setConfirmation(null);
    router.refresh();
  }

  const indexedAt = new Date(submission.indexedAt).toISOString();
  const authorLabel = submission.authorHandle
    ? `@${submission.authorHandle}`
    : submission.authorDid;

  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      {confirmation && (
        <ConfirmationBanner
          confirmation={confirmation}
          submissionName={submission.name}
          onDismiss={dismissConfirmation}
        />
      )}

      <header className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {submission.name}
          </h2>
          <div className="truncate text-sm text-zinc-600 dark:text-zinc-400">
            {submission.house}
            {submission.creator ? ` · ${submission.creator}` : null}
            {submission.releaseYear ? ` · ${submission.releaseYear}` : null}
          </div>
        </div>
        <div className="shrink-0 text-right text-xs text-zinc-500 dark:text-zinc-500">
          <div>{authorLabel}</div>
          <div>{indexedAt}</div>
        </div>
      </header>

      {submission.notes.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {submission.notes.map((note) => (
            <li
              key={note}
              className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
            >
              {note}
            </li>
          ))}
        </ul>
      )}

      {submission.description && (
        <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
          {submission.description}
        </p>
      )}

      {submission.rationale && (
        <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
            Submitter rationale
          </div>
          <div className="whitespace-pre-wrap">{submission.rationale}</div>
        </div>
      )}

      <div className="mt-4 break-all font-mono text-xs text-zinc-500 dark:text-zinc-500">
        {submission.uri}
      </div>

      {!confirmation && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onApprove}
            disabled={pending}
            className="rounded-md border border-amber-600 bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 dark:border-amber-500 dark:bg-amber-500 dark:hover:bg-amber-600"
          >
            {pending && mode === "idle" ? "Working…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode(mode === "reject" ? "idle" : "reject");
              setError(null);
            }}
            disabled={pending}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-amber-600 hover:text-amber-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-amber-500 dark:hover:text-amber-400"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => {
              setMode(mode === "duplicate" ? "idle" : "duplicate");
              setError(null);
            }}
            disabled={pending}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-amber-600 hover:text-amber-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-amber-500 dark:hover:text-amber-400"
          >
            Mark duplicate
          </button>
        </div>
      )}

      {mode === "reject" && !confirmation && (
        <div className="mt-3 space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Optional note (shown on the resolution record)
          </label>
          <textarea
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            rows={3}
            className="block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onReject}
              disabled={pending}
              className="rounded-md border border-amber-600 bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 dark:border-amber-500 dark:bg-amber-500 dark:hover:bg-amber-600"
            >
              {pending ? "Rejecting…" : "Confirm reject"}
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              disabled={pending}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:border-amber-600 hover:text-amber-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-amber-500 dark:hover:text-amber-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "duplicate" && !confirmation && (
        <div className="mt-3 space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Canonical perfume AT-URI
          </label>
          <input
            type="text"
            value={canonicalUri}
            onChange={(e) => setCanonicalUri(e.target.value)}
            placeholder="at://did:plc:.../com.smellgate.perfume/..."
            className="block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            Paste the AT-URI of the existing canonical perfume. Search-powered
            picking is a follow-up on top of Phase 4.F.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onDuplicate}
              disabled={pending}
              className="rounded-md border border-amber-600 bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 dark:border-amber-500 dark:bg-amber-500 dark:hover:bg-amber-600"
            >
              {pending ? "Saving…" : "Confirm duplicate"}
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              disabled={pending}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:border-amber-600 hover:text-amber-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-amber-500 dark:hover:text-amber-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </article>
  );
}

/**
 * Inline confirmation block shown after a successful approve / reject /
 * duplicate action. For approve, we link out to the new canonical
 * perfume's detail page so the curator can verify it rendered. For
 * reject/duplicate we surface the resolution URI (breadcrumb only —
 * there's no public resolution detail page today).
 *
 * Structure is shared across all three outcomes to keep the styling
 * consistent. The banner persists until the curator clicks Dismiss,
 * which triggers `router.refresh()` to pull the card out of the
 * pending list.
 */
function ConfirmationBanner({
  confirmation,
  submissionName,
  onDismiss,
}: {
  confirmation: Confirmation;
  submissionName: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="mb-4 rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100"
    >
      {confirmation.kind === "approved" ? (
        <>
          <div className="font-medium">
            Approved as {submissionName}.{" "}
            <a
              href={`/perfume/${encodeURIComponent(confirmation.perfumeUri)}`}
              className="underline hover:text-amber-700 dark:hover:text-amber-300"
            >
              View canonical perfume →
            </a>
          </div>
          <div className="mt-1 break-all font-mono text-xs text-amber-700 dark:text-amber-300">
            Perfume: {confirmation.perfumeUri}
          </div>
          <div className="break-all font-mono text-xs text-amber-700 dark:text-amber-300">
            Resolution: {confirmation.resolutionUri}
          </div>
        </>
      ) : confirmation.kind === "rejected" ? (
        <>
          <div className="font-medium">Rejected.</div>
          <div className="mt-1 break-all font-mono text-xs text-amber-700 dark:text-amber-300">
            Resolution: {confirmation.resolutionUri}
          </div>
        </>
      ) : (
        <>
          <div className="font-medium">Marked as duplicate.</div>
          <div className="mt-1 break-all font-mono text-xs text-amber-700 dark:text-amber-300">
            Resolution: {confirmation.resolutionUri}
          </div>
        </>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 rounded-md border border-amber-600 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500 dark:text-amber-200 dark:hover:bg-amber-900"
      >
        Dismiss
      </button>
    </div>
  );
}
