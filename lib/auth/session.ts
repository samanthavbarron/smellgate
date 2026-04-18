import { cookies } from "next/headers";
import { getOAuthClient, resetOAuthClient } from "./client";
import type { OAuthSession } from "@atproto/oauth-client-node";

/**
 * Upper bound on a single `client.restore(did)` call.
 *
 * Why a hard timeout exists
 * -------------------------
 * Background: on 2026-04-18, after rotating PUBLIC_URL from
 * `smellgate.fly.dev` to `smellgate.app`, every request that carried a
 * `did` cookie started hanging indefinitely on the Fly app — visible
 * to users as "Login complete, you are being redirected..." followed
 * by a blank page that never loads. Reproduced in Playwright (see
 * `tests/e2e/oauth-login.spec.ts`). Trace shows the `GET /` that
 * follows the callback's 307 redirect never receives a single byte in
 * response — the Node process is stuck rendering the layout.
 *
 * The stall is inside `@atproto/oauth-client`'s `client.restore(did)`:
 * its internal 30s abort signal does not fire, so neither does the
 * `usingLock` release. Once one request for a given DID wedges, every
 * subsequent request for that DID is serialised behind the same
 * `requestLocalLock` entry and also hangs — and because that lock Map
 * is at module scope inside
 * `@atproto/oauth-client/dist/lock.js` (NOT per-instance), the wedge
 * survives nulling our `NodeOAuthClient` singleton and persists until
 * the Node process restarts.
 *
 * Root cause of why `restore()` wedges is still unconfirmed. PR #210
 * fixed a Next.js 16 / undici 7 fetch body-source bug on write paths
 * and `getUnpatchedFetch()` is wired into this codepath too, so
 * whatever is stalling here is NOT that specific bug. Tracked as
 * issue #219 ("Pin down root cause of OAuth `restore()` wedge in
 * Fly prod") — the Playwright trace + curl evidence lives there.
 *
 * What this timeout buys us
 * -------------------------
 * Keep the page responsive. If `restore()` doesn't resolve in the
 * budget, treat the visitor as signed-out for this render and let
 * the rest of the page draw. Re-auth surfaces the LoginForm; browse
 * keeps working for everyone. Every subsequent request for the same
 * stuck DID will also time out at 4s until either the process
 * restarts or issue #220 ships a real lock-level fix — see
 * `resetOAuthClient` in `./client.ts` for why the singleton reset
 * alone is not enough.
 *
 * 4s is the budget. Real restores on prod complete in well under
 * 200ms; any value this large is already a stall. Page-render budget
 * on the home layout is ~1.5s, so a 4s miss is visible but still far
 * better than "indefinite white screen". See `tests/e2e/oauth-login.spec.ts`.
 */
const RESTORE_TIMEOUT_MS = 4000;

export async function getSession(): Promise<OAuthSession | null> {
  const did = await getDid();
  if (!did) return null;

  try {
    const client = await getOAuthClient();
    return await withTimeout(client.restore(did), RESTORE_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof SessionRestoreTimeoutError) {
      // Surface the stall in Fly logs so we can count occurrences
      // per-DID in prod, and refresh instance-local state on the
      // client. This does NOT clear the library's module-scope
      // per-DID lock — see `resetOAuthClient` docstring — so the
      // same DID will keep timing out until a process restart or a
      // real lock-level fix.
      console.warn(
        "[auth] client.restore timed out; resetting OAuth client singleton",
        { did },
      );
      try {
        resetOAuthClient();
      } catch {
        // Swallow — we're already in the error path, don't cascade.
      }
    }
    return null;
  }
}

export async function getDid(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get("did")?.value ?? null;
}

/** Distinct error type so `getSession` can branch on timeout vs any other throw. */
class SessionRestoreTimeoutError extends Error {
  constructor(ms: number) {
    super(`client.restore() exceeded ${ms}ms budget`);
    this.name = "SessionRestoreTimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SessionRestoreTimeoutError(ms)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
