/**
 * Thin client for smellgate-tap (indigo's upstream Tap binary).
 *
 * We used to construct `@atproto/tap`'s `Tap` class here and call
 * `getTap().resolveDid(did)` directly. That package uses
 * `globalThis.fetch`, and in a Next.js 16 server-component / route-
 * handler render path that `fetch` is the patched wrapper from
 * `next/dist/server/lib/patch-fetch.js`. Against a Fly `.internal`
 * hostname the patched fetch *hangs indefinitely* — the request never
 * returns and no timer wired on the outer promise fires, which is why
 * the post-login `GET /` render stalled forever until the client
 * disconnect killed it (issues #216 / #219).
 *
 * The same URL hit via `_nextOriginalFetch` (the pre-patch reference
 * Next.js exposes on its wrapper) responds in ~80ms — confirmed on
 * prod 2026-04-18 with diagnostic logging. So the fix is to call the
 * unpatched fetch directly for every Tap RPC from a server-render
 * context. We also attach an `AbortSignal.timeout` so a genuinely
 * unreachable Tap sidecar can't stall a page render either.
 */

import { getUnpatchedFetch } from "@/lib/auth/unpatched-fetch";

/**
 * Upper bound on any single Tap RPC. Tap's p99 on the .internal network
 * is ~80ms; 3s is a generous ceiling that still bounds page-render time
 * if the sidecar disappears.
 */
const TAP_RPC_TIMEOUT_MS = 3000;

function getTapUrl(): string | null {
  return process.env.TAP_URL || null;
}

function getAuthHeader(): string | undefined {
  const pwd = process.env.TAP_ADMIN_PASSWORD;
  if (!pwd) return undefined;
  return "Basic " + Buffer.from(`admin:${pwd}`).toString("base64");
}

/**
 * Module-local Tap shim. Exposed via `getTap()` so unit tests can
 * swap `tap.resolveDid` with a stub (see
 * `tests/unit/queries/get-account-handle.test.ts`). The named
 * `resolveDid` export below delegates to this object, so an override
 * installed by a test applies to production call sites too.
 */
const tap = {
  async resolveDid(did: string): Promise<unknown | null> {
    const base = getTapUrl();
    if (!base) return null;
    const url = new URL(`/resolve/${did}`, base).toString();
    const fetchImpl = getUnpatchedFetch();
    const headers: Record<string, string> = {};
    const auth = getAuthHeader();
    if (auth) headers["Authorization"] = auth;

    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(TAP_RPC_TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      return (await res.json()) as unknown;
    } catch {
      return null;
    }
  },
};

export const getTap = () => tap;

/**
 * Resolve a DID to its DID document via smellgate-tap's in-process
 * identity cache. Returns `null` when Tap is unconfigured, the DID
 * isn't in Tap's cache (404), the call times out, or any other
 * transport failure. Callers should treat `null` as "try the next
 * resolver" rather than a hard miss.
 */
export function resolveDid(did: string): Promise<unknown | null> {
  return tap.resolveDid(did);
}
