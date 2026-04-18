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
 * `requestLocalLock` entry and also hangs — effectively permanently,
 * because the module-level client singleton keeps the lock Map alive
 * across requests.
 *
 * The fundamental fix belongs upstream (or in `getOAuthClient`'s
 * fetch override — the same story PR #210 opened for write paths).
 * In the meantime this timeout has two jobs:
 *   1. Keep the page responsive. If `restore()` doesn't resolve in
 *      time, treat the visitor as signed-out for this render and let
 *      the rest of the page draw. Re-auth surfaces the LoginForm;
 *      browse keeps working for everyone.
 *   2. Unstick the process. When a timeout fires we throw away the
 *      module-level `NodeOAuthClient` singleton via
 *      `resetOAuthClient()` so the leaked `CachedGetter.pending` /
 *      `requestLocalLock` state does not poison subsequent requests.
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
      // Poison the singleton so the leaked lock/pending entry does not
      // wedge every subsequent request. Best-effort — logging lets us
      // see in Fly logs when the bad path was hit.
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
