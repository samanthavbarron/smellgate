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
 * `tests/e2e/oauth-login.spec.ts`).
 *
 * Diagnostic logging on 2026-04-18 confirmed the real culprit was
 * `getAccountHandle()` → `Tap.resolveDid()`: Next.js 16's patched
 * `globalThis.fetch` hangs indefinitely against Fly `.internal`
 * hostnames. `lib/tap/index.ts` now calls the pre-patch fetch with
 * its own AbortSignal.timeout, which fixed login end-to-end.
 *
 * `client.restore(did)` itself completed in ~200ms in every prod
 * trace, so the 4s timeout here never actually fired. Kept as a
 * defensive backstop: if a future failure mode does cause `restore`
 * to stall (library-level `requestLocalLock` wedge, upstream regression,
 * etc.) the page will still draw rather than hang on a blank screen.
 *
 * What this timeout buys us
 * -------------------------
 * Keep the page responsive. If `restore()` ever doesn't resolve in
 * the budget, treat the visitor as signed-out for this render and
 * let the rest of the page draw. 4s is the budget — real restores
 * on prod complete in well under 200ms — and a 4s miss is visible
 * but still far better than "indefinite white screen".
 * See `tests/e2e/oauth-login.spec.ts`.
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
