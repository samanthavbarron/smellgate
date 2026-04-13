/**
 * Top-level site header (Phase 4.A).
 *
 * Server component. Takes a pre-resolved session-ish summary from the
 * layout so it can render Profile / Curator nav links conditionally
 * without talking to the DB itself. Intentionally stateless — the
 * layout is the single place that asks "who is this visitor?".
 *
 * Visual target: letterboxd-minimal. Thin border, wordmark left, nav
 * right, no drop shadows, no decorative chrome. The search box lives
 * here in a later PR (Phase 4.F) — leave the space but do not build
 * it.
 */
import Link from "next/link";
import { LogoutButton } from "./LogoutButton";

export interface SiteHeaderProps {
  /** Whether there's a logged-in session. */
  signedIn: boolean;
  /** Handle to display next to the logout control, if known. */
  handle: string | null;
  /** Whether the signed-in user is a configured curator. */
  isCurator: boolean;
}

export function SiteHeader({ signedIn, handle, isCurator }: SiteHeaderProps) {
  return (
    <header className="border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
        <Link
          href="/"
          className="font-semibold tracking-tight text-zinc-900 dark:text-zinc-100"
        >
          smellgate
        </Link>

        <nav className="flex items-center gap-5 text-sm">
          <Link
            href="/"
            className="text-zinc-600 hover:text-amber-700 dark:text-zinc-400 dark:hover:text-amber-400"
          >
            Home
          </Link>
          {signedIn && (
            <Link
              href="/profile"
              className="text-zinc-600 hover:text-amber-700 dark:text-zinc-400 dark:hover:text-amber-400"
            >
              Profile
            </Link>
          )}
          {signedIn && isCurator && (
            <Link
              href="/curator"
              className="text-zinc-600 hover:text-amber-700 dark:text-zinc-400 dark:hover:text-amber-400"
            >
              Curator
            </Link>
          )}
          {signedIn ? (
            <div className="flex items-center gap-3">
              {handle && (
                <span className="hidden text-xs text-zinc-500 sm:inline dark:text-zinc-500">
                  @{handle}
                </span>
              )}
              <LogoutButton />
            </div>
          ) : (
            <Link
              href="/#sign-in"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-amber-600 hover:text-amber-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-amber-500 dark:hover:text-amber-400"
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
