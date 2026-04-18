"use client";

/**
 * Shelf composer (Phase 4.D, issue #69).
 *
 * Writes a `app.smellgate.shelfItem` record for the target perfume
 * via `/api/smellgate/shelf`, then redirects to `/profile/me`. See
 * CommentComposer header for the "client component + fetch"
 * rationale.
 *
 * `acquiredAt` is an `<input type="date">` that we widen to an ISO
 * datetime on submit (midnight UTC). The server's `requireDatetime`
 * parses whatever we pass with `Date.parse`, so either shape works,
 * but the lexicon is `datetime` — sending a proper ISO string keeps
 * Tap's `$safeParse` happy on the way back in.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ShelfComposer({ perfumeUri }: { perfumeUri: string }) {
  const router = useRouter();
  const [acquiredAt, setAcquiredAt] = useState("");
  const [bottleSizeMl, setBottleSizeMl] = useState("");
  const [isDecant, setIsDecant] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    let acquiredAtIso: string | undefined;
    if (acquiredAt.length > 0) {
      // "YYYY-MM-DD" → ISO at midnight UTC
      const parsed = new Date(`${acquiredAt}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) {
        setError("Acquired date is invalid.");
        return;
      }
      acquiredAtIso = parsed.toISOString();
    }

    let bottleSize: number | undefined;
    if (bottleSizeMl.length > 0) {
      const n = Number(bottleSizeMl);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        setError("Bottle size must be a positive whole number of ml.");
        return;
      }
      bottleSize = n;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/smellgate/shelf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          perfumeUri,
          acquiredAt: acquiredAtIso,
          bottleSizeMl: bottleSize,
          // Only send `isDecant` when the user actually toggled it on;
          // the action treats `undefined` as "field omitted", which is
          // the right default for a checkbox left alone.
          isDecant: isDecant ? true : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      router.push("/profile/me");
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
          Acquired
          <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-500">
            (optional)
          </span>
        </label>
        <input
          type="date"
          value={acquiredAt}
          onChange={(e) => setAcquiredAt(e.target.value)}
          disabled={loading}
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-amber-600 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Bottle size (ml)
          <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-500">
            (optional)
          </span>
        </label>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={bottleSizeMl}
          onChange={(e) => setBottleSizeMl(e.target.value)}
          disabled={loading}
          placeholder="50"
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-amber-600 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={isDecant}
            onChange={(e) => setIsDecant(e.target.checked)}
            disabled={loading}
            className="h-4 w-4 rounded border-zinc-300 text-amber-600 focus:ring-amber-600 dark:border-zinc-700"
          />
          This is a decant
        </label>
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="rounded-md border border-amber-600 bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-500 dark:bg-amber-500 dark:hover:bg-amber-600"
        >
          {loading ? "Adding…" : "Add to shelf"}
        </button>
      </div>
    </form>
  );
}
