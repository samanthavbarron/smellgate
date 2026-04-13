"use client";

/**
 * Vote buttons (Phase 4.D, issue #69).
 *
 * Inline up/down controls on a `com.smellgate.description` card,
 * replacing the Phase 4.B disabled stubs. POSTs to
 * `/api/smellgate/vote` with `{ descriptionUri, direction }`; on
 * success, triggers `router.refresh()` so the server component
 * re-renders the new vote tally.
 *
 * Unsigned users shouldn't render this at all — the parent page does
 * the check. This component assumes signed-in.
 *
 * A successful click paints the button amber and leaves it painted
 * until the refresh settles. On error we fall back to a small inline
 * message below the column and re-enable the buttons.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

type Pending = "up" | "down" | null;

export function VoteButtons({
  descriptionUri,
  score,
  upCount,
  downCount,
}: {
  descriptionUri: string;
  score: number;
  upCount: number;
  downCount: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [justVoted, setJustVoted] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);

  async function vote(direction: "up" | "down") {
    setPending(direction);
    setError(null);
    try {
      const res = await fetch("/api/smellgate/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ descriptionUri, direction }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setJustVoted(direction);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Vote failed.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5 text-xs text-zinc-500 dark:text-zinc-500">
      <button
        type="button"
        aria-label="Upvote"
        title={`Upvote (${upCount})`}
        onClick={() => vote("up")}
        disabled={pending !== null}
        className={
          "rounded px-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
          (justVoted === "up"
            ? "text-amber-700 dark:text-amber-400"
            : "hover:text-amber-700 dark:hover:text-amber-400")
        }
      >
        ▲
      </button>
      <span
        className={
          score > 0
            ? "font-semibold text-amber-700 dark:text-amber-400"
            : "font-semibold text-zinc-700 dark:text-zinc-300"
        }
      >
        {score}
      </span>
      <button
        type="button"
        aria-label="Downvote"
        title={`Downvote (${downCount})`}
        onClick={() => vote("down")}
        disabled={pending !== null}
        className={
          "rounded px-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
          (justVoted === "down"
            ? "text-amber-700 dark:text-amber-400"
            : "hover:text-amber-700 dark:hover:text-amber-400")
        }
      >
        ▼
      </button>
      {error && (
        <span
          className="mt-1 max-w-[6rem] text-center text-[10px] text-red-600 dark:text-red-400"
          role="alert"
        >
          {error}
        </span>
      )}
    </div>
  );
}
