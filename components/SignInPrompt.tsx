/**
 * Shared signed-out Sign-in prompt used by the 5 composer pages and the
 * anon-user CTA on `app/perfume/[uri]/page.tsx`.
 *
 * Historically each composer page defined its own `SignInPrompt` local
 * component that linked to `/oauth/login?next=<path>` — but
 * `/oauth/login` is POST-only, so every one of those links returned 405
 * on GET (#178). We now route to `/#sign-in`, the same anchor
 * `SiteHeader` and `app/profile/me/page.tsx` use, which surfaces the
 * home-page `LoginForm` that does its own POST to `/oauth/login`.
 *
 * Return-URL behavior (sending the user back to where they came from
 * after sign-in) would need server-side state stashing since `/#sign-in`
 * hands off to a client-side form; intentionally out of scope for the
 * #178 fix.
 */
import Link from "next/link";

export function SignInPrompt({ message }: { message?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
      <p>{message ?? "You need to sign in first."}</p>
      <Link
        href="/#sign-in"
        className="mt-3 inline-block rounded-md border border-amber-600 px-3 py-1.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 dark:border-amber-500 dark:text-amber-400 dark:hover:bg-amber-950/40"
      >
        Sign in
      </Link>
    </div>
  );
}
