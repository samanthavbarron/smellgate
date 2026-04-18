"use client";

/**
 * Description composer (Phase 4.D, issue #69).
 *
 * Writes a `app.smellgate.description` record for the target perfume
 * via `/api/smellgate/description`, then redirects back to the
 * perfume detail page. See CommentComposer header for the "client
 * component + fetch" rationale.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { countGraphemes } from "../../lib/graphemes";

// Grapheme count, not UTF-16 code-unit count, so we agree with the
// lexicon's `maxGraphemes` constraint on emoji and combining marks.
// See `lib/graphemes.ts` and #83.
const MAX_GRAPHEMES = 5000;

export function DescriptionComposer({
  perfumeUri,
  redirectTo,
}: {
  perfumeUri: string;
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
      setError("Description must not be empty.");
      return;
    }
    if (tooLong) {
      setError(`Description must be ≤ ${MAX_GRAPHEMES} graphemes.`);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/smellgate/description", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ perfumeUri, body }),
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
          Description
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          disabled={loading}
          placeholder="What does it actually smell like?"
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
          {loading ? "Posting…" : "Post description"}
        </button>
      </div>
    </form>
  );
}
