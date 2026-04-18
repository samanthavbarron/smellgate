"use client";

/**
 * Perfume-submission composer (Phase 4.D, issue #69).
 *
 * Writes a `app.smellgate.perfumeSubmission` record via
 * `/api/smellgate/submission`. On success, shows an inline
 * confirmation with the server's `status` / `message` (issue #111)
 * and a link to `/profile/me/submissions` (#131), **before** routing
 * anywhere — otherwise a web-UI submitter would never see the
 * "queued for curator review" message that only lives in the JSON
 * response. The confirmation surfaces the `idempotent: true` case
 * too so a re-submit doesn't silently look identical to a fresh one.
 *
 * `notes` is entered as a comma-separated string; we split, trim,
 * lowercase, and dedupe before sending — matching what
 * `submitPerfumeAction` will normalize server-side, so the user sees
 * the same rules surfaced in the UI.
 */

import Link from "next/link";
import { useState } from "react";

function normalizeNotes(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const n = raw.trim().toLowerCase();
    if (n.length === 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

interface SubmitSuccess {
  uri: string;
  status: string;
  message: string;
  idempotent?: boolean;
}

export function PerfumeSubmissionComposer() {
  const [name, setName] = useState("");
  const [house, setHouse] = useState("");
  const [creator, setCreator] = useState("");
  const [releaseYear, setReleaseYear] = useState("");
  const [notesText, setNotesText] = useState("");
  const [description, setDescription] = useState("");
  const [rationale, setRationale] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SubmitSuccess | null>(null);

  const notes = normalizeNotes(notesText);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (name.trim().length === 0) {
      setError("Name is required.");
      return;
    }
    if (house.trim().length === 0) {
      setError("House is required.");
      return;
    }
    if (notes.length === 0) {
      setError("At least one note is required.");
      return;
    }

    let releaseYearN: number | undefined;
    if (releaseYear.trim().length > 0) {
      const n = Number(releaseYear);
      if (!Number.isInteger(n)) {
        setError("Release year must be a whole number.");
        return;
      }
      releaseYearN = n;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/smellgate/submission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          name: name.trim(),
          house: house.trim(),
          creator: creator.trim() ? creator.trim() : undefined,
          releaseYear: releaseYearN,
          notes,
          description: description.trim() ? description.trim() : undefined,
          rationale: rationale.trim() ? rationale.trim() : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        uri?: string;
        status?: string;
        message?: string;
        idempotent?: boolean;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      // Issue #111: surface the server's human-readable status in the
      // UI, not just the CLI. We keep the user on this page with an
      // inline confirmation + a link to /profile/me/submissions —
      // this replaces the old `router.push("/profile/me")` behavior
      // which silently dropped the new submission into a redirect.
      setSuccess({
        uri: data.uri ?? "",
        status: data.status ?? "pending_review",
        message:
          data.message ?? "Your submission is queued for curator review.",
        idempotent: data.idempotent,
      });
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div
        role="status"
        className="space-y-3 rounded-lg border border-amber-500 bg-amber-50 p-6 dark:border-amber-500 dark:bg-amber-950"
      >
        <h2 className="text-lg font-semibold tracking-tight text-amber-900 dark:text-amber-100">
          {success.idempotent
            ? "You already submitted this perfume."
            : "Submission received."}
        </h2>
        <p className="text-sm text-amber-800 dark:text-amber-200">
          {success.message}
        </p>
        {success.uri && (
          <div className="break-all font-mono text-xs text-amber-700 dark:text-amber-300">
            {success.uri}
          </div>
        )}
        <div className="flex flex-wrap gap-2 pt-2">
          <Link
            href="/profile/me/submissions"
            className="rounded-md border border-amber-600 bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 dark:border-amber-500 dark:bg-amber-500 dark:hover:bg-amber-600"
          >
            View my submissions
          </Link>
          <button
            type="button"
            onClick={() => {
              setSuccess(null);
              setName("");
              setHouse("");
              setCreator("");
              setReleaseYear("");
              setNotesText("");
              setDescription("");
              setRationale("");
              setError(null);
            }}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-amber-600 hover:text-amber-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-amber-500 dark:hover:text-amber-400"
          >
            Submit another
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <TextField
        label="Name"
        required
        value={name}
        onChange={setName}
        disabled={loading}
        placeholder="Vespertine"
      />
      <TextField
        label="House"
        required
        value={house}
        onChange={setHouse}
        disabled={loading}
        placeholder="Maison Vésper"
      />
      <TextField
        label="Creator"
        optional
        value={creator}
        onChange={setCreator}
        disabled={loading}
        placeholder="Perfumer name"
      />
      <TextField
        label="Release year"
        optional
        type="number"
        value={releaseYear}
        onChange={setReleaseYear}
        disabled={loading}
        placeholder="2024"
      />

      <div>
        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Notes
          <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-500">
            (comma-separated, will be lowercased)
          </span>
        </label>
        <input
          type="text"
          value={notesText}
          onChange={(e) => setNotesText(e.target.value)}
          disabled={loading}
          placeholder="bergamot, incense, cedar"
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-amber-600 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        />
        {notes.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {notes.map((n) => (
              <span
                key={n}
                className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              >
                {n}
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Description
          <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-500">
            (optional)
          </span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          disabled={loading}
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-amber-600 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Rationale
          <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-500">
            (optional — why should the curators add this?)
          </span>
        </label>
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          rows={3}
          disabled={loading}
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-amber-600 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        />
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
          {loading ? "Submitting…" : "Submit perfume"}
        </button>
      </div>
    </form>
  );
}

function TextField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  required,
  optional,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  placeholder?: string;
  required?: boolean;
  optional?: boolean;
  type?: "text" | "number";
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {optional && (
          <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-500">
            (optional)
          </span>
        )}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-amber-600 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
      />
    </div>
  );
}
