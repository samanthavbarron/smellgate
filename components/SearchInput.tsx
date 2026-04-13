/**
 * Search input for the `/search` page (Phase 4.F, issue #71).
 *
 * Client component — owns a piece of local input state and navigates
 * to `/search?q=<encoded>` on submit. Navigation goes through
 * `next/navigation`'s `useRouter().push` rather than a plain `<form
 * action>` so the URL updates without a full page reload and the
 * server component on the other end re-runs with the new `searchParams`.
 *
 * Deliberately minimal: no debounced live search, no icon, no clear
 * button. docs/ui.md forbids icon libraries and the task description
 * calls for "bare-bones substring search" — shipping anything more
 * would be speculative.
 */
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SearchInput({
  initialQuery = "",
  autoFocus = false,
}: {
  initialQuery?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          router.push("/search");
          return;
        }
        router.push(`/search?q=${encodeURIComponent(trimmed)}`);
      }}
      className="flex w-full items-center gap-2"
    >
      <input
        type="search"
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search by perfume name or house"
        aria-label="Search perfumes"
        autoFocus={autoFocus}
        className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-amber-600 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-amber-500"
      />
      <button
        type="submit"
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-amber-600 hover:text-amber-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-amber-500 dark:hover:text-amber-400"
      >
        Search
      </button>
    </form>
  );
}
