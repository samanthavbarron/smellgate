"use client";

/**
 * Comment composer (Phase 4.D, issue #69).
 *
 * Flat reply on a `com.smellgate.review`. Posts a
 * `com.smellgate.comment` via `/api/smellgate/comment` and, on
 * success, redirects to the parent perfume detail page (the review's
 * perfume — the server component that renders this form already knows
 * that URL and passes it in as `redirectTo`).
 *
 * Why a plain client component + fetch instead of a server action:
 * the Phase 3 POST route handlers ARE the server boundary for
 * `com.smellgate.*` writes. Wrapping them again in a `"use server"`
 * action would only add a layer. See PR #69 body for the full
 * rationale. Same pattern for all six composers in this directory.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { countGraphemes } from "../../lib/graphemes";

// Grapheme count, not UTF-16 code-unit count. See lib/graphemes.ts and #83.
const MAX_GRAPHEMES = 5000;

export function CommentComposer({
  reviewUri,
  redirectTo,
}: {
  reviewUri: string;
  redirectTo: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bodyGraphemes = countGraphemes(body);
  const tooLong = bodyGraphemes > MAX_GRAPHEMES;
  const empty = body.trim().length === 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (empty) {
      setError("Comment must not be empty.");
      return;
    }
    if (tooLong) {
      setError(`Comment must be ≤ ${MAX_GRAPHEMES} graphemes.`);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/smellgate/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ reviewUri, body }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Comment
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          disabled={loading}
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-amber-600 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        />
        <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
          <span className={tooLong ? "text-red-600 dark:text-red-400" : ""}>
            {bodyGraphemes}
          </span>{" "}
          / {MAX_GRAPHEMES}
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading || empty || tooLong}
          className="rounded-md border border-amber-600 bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-500 dark:bg-amber-500 dark:hover:bg-amber-600"
        >
          {loading ? "Posting…" : "Post comment"}
        </button>
      </div>
    </form>
  );
}
