/**
 * Return a `fetch` implementation that bypasses Next.js 16's route-handler
 * fetch patch.
 *
 * Why this exists
 * ---------------
 *
 * Next.js 16 replaces `globalThis.fetch` with a wrapped version inside
 * route handlers and server components
 * (`next/dist/server/lib/patch-fetch.js`). Among other things, when the
 * patched fetch receives an existing `Request` object, it rebuilds it via
 * `new Request(request.url, { body: request.body, ... })`. The original
 * `request.body` is a `ReadableStream`, and an `ReadableStream`-backed
 * Request has `body.source === null` — the body is only re-readable by
 * streaming once.
 *
 * This interacts badly with `@atproto/oauth-client`'s DPoP wrapper. The
 * DPoP wrapper does its own `new Request(input, init)` (with a string
 * body; `source` is set) and then calls `fetch(request)`. With Next's
 * patched fetch in the chain, the inner Request's stream-body becomes
 * the outer Request's body, and `source` is lost. When the PDS returns
 * 401 (the normal DPoP nonce-challenge response), undici 7 — bundled
 * with Node 24.15+ — follows the Fetch spec's authentication-retry path,
 * which runs `safelyExtractBody(request.body.source)` and throws
 * `expected non-null body source` because `source` is null.
 *
 * Symptom in production (Fly, 2026-04-18):
 *   TypeError: fetch failed
 *     [cause]: Error: expected non-null body source
 *       request: Request { method: 'POST', url: '…/xrpc/com.atproto.repo.createRecord', … }
 *
 * Every write-path server action (shelfItem, review, description, vote,
 * comment, submission) goes through this code path and every one fails.
 * Integration tests pass on the dev Codespace because its Node (24.11)
 * ships a slightly older undici that doesn't have the spec-compliant
 * retry; the bug only surfaces on 24.15+.
 *
 * What this helper returns
 * ------------------------
 *
 * Next.js exposes the pre-patch fetch on the patched function as
 * `_nextOriginalFetch` (see `patch-fetch.js`: `patched._nextOriginalFetch = originFetch`).
 * We return that if present. If the patch isn't installed (standalone
 * Node process, unit tests, dev mode without app-router context) we
 * return `globalThis.fetch` unchanged.
 *
 * The resulting fetch is not wrapped by Next at all — no cache key
 * computation, no Request-rebuild, no dedupe. PDS write traffic does
 * not benefit from any of those (POST, Authorization header → always
 * uncacheable, always unique), so nothing is lost.
 *
 * This is deliberately the smallest possible fix. We do not patch
 * `@atproto/oauth-client`, do not pin undici, do not touch Node. A
 * future Next.js or undici release that makes the double-wrap safe
 * will leave this helper inert (it'll still return a working fetch).
 */

type UnpatchedMarker = {
  _nextOriginalFetch?: typeof fetch;
  __nextPatched?: true;
};

export function getUnpatchedFetch(): typeof fetch {
  const current = globalThis.fetch as typeof fetch & UnpatchedMarker;
  // Next's patched fetch exposes the pre-patch reference on itself. If
  // it's there, use it; otherwise fall through to whatever fetch is on
  // the global (unit-test runs, dev-mode script paths, etc.).
  if (current && typeof current._nextOriginalFetch === "function") {
    return current._nextOriginalFetch.bind(globalThis);
  }
  return current.bind(globalThis);
}
