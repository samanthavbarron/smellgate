"use client";

/**
 * Review composer (Phase 4.D, issue #69).
 *
 * Writes a `com.smellgate.review` record for the target perfume via
 * `/api/smellgate/review`, then redirects back to the perfume detail
 * page. See CommentComposer header for the "client component +
 * fetch" rationale.
 *
 * Client-side validation mirrors `postReviewAction` exactly:
 *   - rating: integer 1-10
 *   - sillage: integer 1-5
 *   - longevity: integer 1-5
 *   - body: non-empty, ≤ 15000 chars
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

const MAX_CHARS = 15000;

export function ReviewComposer({
  perfumeUri,
  redirectTo,
}: {
  perfumeUri: string;
  redirectTo: string;
}) {
  const router = useRouter();
  const [rating, setRating] = useState("7");
  const [sillage, setSillage] = useState("3");
  const [longevity, setLongevity] = useState("3");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooLong = body.length > MAX_CHARS;
  const empty = body.trim().length === 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const ratingN = Number(rating);
    const sillageN = Number(sillage);
    const longevityN = Number(longevity);
    if (!Number.isInteger(ratingN) || ratingN < 1 || ratingN > 10) {
      setError("Rating must be a whole number between 1 and 10.");
      return;
    }
    if (!Number.isInteger(sillageN) || sillageN < 1 || sillageN > 5) {
      setError("Sillage must be a whole number between 1 and 5.");
      return;
    }
    if (!Number.isInteger(longevityN) || longevityN < 1 || longevityN > 5) {
      setError("Longevity must be a whole number between 1 and 5.");
      return;
    }
    if (empty) {
      setError("Review body must not be empty.");
      return;
    }
    if (tooLong) {
      setError(`Review body must be ≤ ${MAX_CHARS} characters.`);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/smellgate/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          perfumeUri,
          rating: ratingN,
          sillage: sillageN,
          longevity: longevityN,
          body,
        }),
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <NumberField
          label="Rating"
          suffix="/ 10"
          min={1}
          max={10}
          value={rating}
          onChange={setRating}
          disabled={loading}
        />
        <NumberField
          label="Sillage"
          suffix="/ 5"
          min={1}
          max={5}
          value={sillage}
          onChange={setSillage}
          disabled={loading}
        />
        <NumberField
          label="Longevity"
          suffix="/ 5"
          min={1}
          max={5}
          value={longevity}
          onChange={setLongevity}
          disabled={loading}
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Review
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          disabled={loading}
          placeholder="Notes, wear, projection, compared to what you know…"
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-amber-600 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        />
        <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
          <span className={tooLong ? "text-red-600 dark:text-red-400" : ""}>
            {body.length}
          </span>{" "}
          / {MAX_CHARS}
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
          {loading ? "Posting…" : "Post review"}
        </button>
      </div>
    </form>
  );
}

function NumberField({
  label,
  suffix,
  min,
  max,
  value,
  onChange,
  disabled,
}: {
  label: string;
  suffix: string;
  min: number;
  max: number;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}{" "}
        <span className="text-xs text-zinc-500 dark:text-zinc-500">
          {suffix}
        </span>
      </label>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-amber-600 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
      />
    </div>
  );
}
