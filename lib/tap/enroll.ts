/**
 * Tap /repos/add DID enrollment (issues #166, #190).
 *
 * Background: `smellgate-tap` (indigo's upstream Tap binary) runs with
 * `TAP_SIGNAL_COLLECTION=app.smellgate.shelfItem`, which is meant to
 * auto-enroll repos that publish a shelfItem record. In practice
 * auto-enrollment is unreliable for external bsky.social-hosted
 * accounts — the bug-hunt in #166 and #190 confirmed that shelf/review/
 * comment writes from a freshly-created bsky.social DID never reach the
 * smellgate cache. The only DIDs that reliably appeared in the cache
 * were ones enrolled explicitly via `tap/seed-curator.sh`.
 *
 * The fix is to sidestep auto-enrollment entirely: whenever a user
 * completes OAuth login to smellgate, the callback handler knows their
 * DID, so we can POST to Tap's `/repos/add` admin endpoint and enroll
 * them synchronously. Future writes from that DID flow through the
 * firehose subscription without any further ceremony.
 *
 * This module mirrors `tap/seed-curator.sh` in TypeScript. The wire
 * format (POST /repos/add with `{"dids": ["did:plc:..."]}` and HTTP
 * Basic auth using `admin:<TAP_ADMIN_PASSWORD>`) is the upstream Tap
 * binary's admin API, documented in `tap/seed-curator.sh` and exercised
 * by `@atproto/tap`'s own `Tap.addRepos` client.
 *
 * Design choices:
 *
 * - Soft-fail on misconfig. If `TAP_URL` or `TAP_ADMIN_PASSWORD` is
 *   unset (local dev, the bug-bash dev network, unit-test harnesses),
 *   return immediately and log nothing. Login must work without Tap.
 * - Short timeout (3s) and never throws. A dead or slow Tap must not
 *   block the OAuth redirect. The worst case is "this user's records
 *   won't be indexed until their next login retries" — a UX nag, not
 *   a crash.
 * - Idempotent on the Tap side. `/repos/add` accepts duplicates. We
 *   call it on every login so there is no "have we enrolled this DID
 *   yet?" state to track.
 * - Uses the bare `fetch` API rather than `@atproto/tap`'s `Tap`
 *   client. The `Tap` client throws on non-2xx and does not expose
 *   `AbortSignal`; a thin wrapper around `fetch` is both simpler and
 *   matches the login-path failure model (swallow everything).
 * - Calls the pre-patch fetch (see `lib/auth/unpatched-fetch.ts`).
 *   Next.js 16's route-handler `fetch` wrapper hangs indefinitely
 *   against Fly `.internal` hostnames — against the OAuth callback
 *   that was bounded by the 3s `AbortSignal` below so it didn't
 *   stall the redirect, but it did mean every enrollment silently
 *   timed out, which is issue #216's co-cause. Using the unpatched
 *   fetch makes the POST actually complete.
 */

import { getUnpatchedFetch } from "@/lib/auth/unpatched-fetch";

const ENROLL_TIMEOUT_MS = 3000;

/**
 * Enroll a DID with smellgate-tap so the firehose indexer picks up
 * records authored by that repo. Safe to call on every OAuth callback:
 *
 *   - No-op when `TAP_URL` or `TAP_ADMIN_PASSWORD` is unset.
 *   - Never throws. Failures are logged with `console.warn` and
 *     swallowed so they cannot break the login redirect.
 *   - Aborts after {@link ENROLL_TIMEOUT_MS} ms.
 *
 * Returns once the POST has completed, timed out, or been skipped.
 * Callers should `await` this so the 3s ceiling is respected, but
 * intentionally ignore the resolved value.
 */
export async function enrollInTap(did: string): Promise<void> {
  const url = process.env.TAP_URL;
  const pwd = process.env.TAP_ADMIN_PASSWORD;
  if (!url || !pwd) {
    // Dev mode, bug-bash local network, or a misconfigured deploy.
    // Soft-fail: login still works, the DID just won't be enrolled.
    // `instrumentation.ts` hard-fails production boot when the
    // password is empty, so this branch is unreachable in a
    // correctly-configured prod.
    return;
  }

  const endpoint = new URL("/repos/add", url).toString();
  const authHeader =
    "Basic " + Buffer.from(`admin:${pwd}`).toString("base64");

  try {
    const res = await getUnpatchedFetch()(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      // Tap's wire format is `{"dids": [...]}`. Singular `{"did":...}`
      // is silently ignored by the Go binary. See
      // `node_modules/@atproto/tap/src/client.ts#addRepos`.
      body: JSON.stringify({ dids: [did] }),
      signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 409 ("already enrolled") is not actually returned by the
      // current Tap binary — duplicates return 200 — but we keep the
      // check as a belt-and-braces allowance in case upstream starts
      // differentiating. Anything else gets a warn.
      if (res.status !== 409) {
        console.warn(
          `[tap] enrollment POST for ${did} returned ${res.status}`,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tap] enrollment POST for ${did} failed: ${msg}`);
  }
}
