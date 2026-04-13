"use client";

/**
 * Perfume-submission composer (Phase 4.D, issue #69).
 *
 * Writes a `com.smellgate.perfumeSubmission` record via
 * `/api/smellgate/submission`, then redirects to `/profile/me` so the
 * user can see the record they just created. Curator resolution of
 * the submission happens separately (Phase 4.E).
 *
 * `notes` is entered as a comma-separated string; we split, trim,
 * lowercase, and dedupe before sending — matching what
 * `submitPerfumeAction` will normalize server-side, so the user sees
 * the same rules surfaced in the UI.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

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

export function PerfumeSubmissionComposer() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [house, setHouse] = useState("");
  const [creator, setCreator] = useState("");
  const [releaseYear, setReleaseYear] = useState("");
  const [notesText, setNotesText] = useState("");
  const [description, setDescription] = useState("");
  const [rationale, setRationale] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
