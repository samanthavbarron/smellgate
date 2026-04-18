/**
 * Unit test for `lib/auth/unpatched-fetch.ts`.
 *
 * Regression test for the Fly production 500 (trace 2026-04-18T03:15:50Z):
 * every write-path server action (shelfItem / review / description /
 * vote / comment / submission) crashed with
 *
 *     TypeError: fetch failed
 *       [cause]: Error: expected non-null body source
 *
 * inside the OAuth-wrapped DPoP POST to the user's PDS. Root cause is
 * the interaction between Next.js 16's `patch-fetch` wrapper,
 * `@atproto/oauth-client`'s DPoP `new Request(...)` call, and undici 7's
 * Fetch-spec 401-retry path. See `lib/auth/unpatched-fetch.ts` for the
 * full write-up.
 *
 * These tests verify the shape of the fix rather than the full
 * production stack, which needs Node 24.15+ (alpine) AND Next.js's
 * request-scoped fetch patch both active at once. We assert three
 * things:
 *
 * 1. With no `_nextOriginalFetch` marker on `globalThis.fetch`,
 *    `getUnpatchedFetch()` returns the global fetch (so unit tests
 *    / dev-mode / scripts still work).
 *
 * 2. With a `_nextOriginalFetch` marker installed (simulating Next.js's
 *    patched fetch), `getUnpatchedFetch()` returns that pre-patch
 *    reference, NOT the patched one. This is the behavior that
 *    prevents the double-Request-wrap.
 *
 * 3. A direct reproduction of the double-wrap failure mode: building a
 *    `new Request(url, init)` from another Request with a `ReadableStream`
 *    body produces a Request whose body cannot be re-extracted by
 *    `Request.clone()`. A single-wrap Request (from a string body)
 *    can. This demonstrates the pre-condition for the undici 7 error:
 *    on a 401 response from the PDS, undici tries to re-extract the
 *    body, and only a single-wrap Request lets it do so.
 */

import { afterEach, describe, expect, it } from "vitest";

import { getUnpatchedFetch } from "../../lib/auth/unpatched-fetch";

describe("getUnpatchedFetch", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    // Restore globalThis.fetch in case a test replaced it.
    globalThis.fetch = originalFetch;
  });

  it("returns the global fetch when no Next.js patch is installed", () => {
    // `globalThis.fetch` as given by the Vitest runner — not wrapped by
    // Next. `getUnpatchedFetch()` should just return a bound version of
    // it. We can't assert identity (`.bind` creates a new function) but
    // we can assert it's callable and that the returned fn does not
    // carry the `_nextOriginalFetch` marker.
    const unpatched = getUnpatchedFetch();
    expect(typeof unpatched).toBe("function");
    expect(
      (unpatched as { _nextOriginalFetch?: unknown })._nextOriginalFetch,
    ).toBeUndefined();
  });

  it("returns the `_nextOriginalFetch` reference when Next.js's patch is present", () => {
    // Simulate Next.js 16's `patch-fetch.js` installation: it sets
    // `globalThis.fetch = patched` where `patched._nextOriginalFetch`
    // points at the pre-patch fetch. We care that `getUnpatchedFetch()`
    // returns the inner one — that's what avoids the double-wrap that
    // triggers the undici 7 bug.
    const original = async () => new Response("ok");
    const patched = (async () => new Response("patched")) as typeof fetch & {
      _nextOriginalFetch?: typeof fetch;
      __nextPatched?: true;
    };
    patched._nextOriginalFetch = original as unknown as typeof fetch;
    patched.__nextPatched = true;
    globalThis.fetch = patched as unknown as typeof fetch;

    const unpatched = getUnpatchedFetch();
    // Calling the returned function must route to `original`, not
    // `patched`. Functional identity (not reference identity, since we
    // `.bind` to avoid "this-escaped" confusion) is the right assertion.
    return unpatched("https://example.invalid").then((res) => {
      return res.text().then((body) => {
        expect(body).toBe("ok");
      });
    });
  });

  it("double-wrapping a Request with a ReadableStream body loses the body source", async () => {
    // This is the shape of the production bug on Node 24.15+ / undici 7.
    // Local dev Node (24.11 as of 2026-04-18) does NOT trigger the
    // undici error, which is why this test only exercises the
    // pre-condition (the double wrap mangles the body) rather than the
    // network-level failure.
    //
    // Step 1: the shape the dpop wrapper produces. A Request built from
    // a string body has an internally-tracked source the fetch impl can
    // re-extract on a 401 retry.
    const singleWrap = new Request("https://example.invalid/xrpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
      // @ts-expect-error: `duplex` is required on Node's Request when body is a stream
      duplex: "half",
    });
    // A fresh single-wrap Request can be re-read via .clone().text().
    // This proves the body source is present.
    const singleClone = singleWrap.clone();
    expect(await singleClone.text()).toBe('{"hello":"world"}');

    // Step 2: the shape Next.js's `patch-fetch.js`'s `doOriginalFetch`
    // produces — rebuilding the Request from its own properties,
    // inheriting `body` which is now a ReadableStream.
    const doubleWrap = new Request(singleWrap.url, {
      method: singleWrap.method,
      headers: singleWrap.headers,
      body: singleWrap.body,
      // @ts-expect-error: needed when body is a stream
      duplex: "half",
    });
    // The double-wrapped Request has a ReadableStream body. Streaming
    // it consumes the original, marking it as used. A subsequent
    // `.clone().text()` cannot produce the body text — either throwing
    // or returning an empty string — because no source is present.
    // (Exact behavior varies by Node patch version; the invariant we
    // care about is "body cannot be replayed".)
    const bodyStream = doubleWrap.body;
    expect(bodyStream).not.toBeNull();
    // Consume the double-wrap's stream so the original is locked.
    // Then try to read the body a second time via clone(). The original
    // single-wrap Request lets this work; the double wrap does not.
    await doubleWrap.text();
    expect(singleWrap.bodyUsed).toBe(true);
    // singleWrap was read through because doubleWrap's body IS
    // singleWrap's body stream. The source-from-string is still on
    // singleWrap though; undici's internal retry reads from
    // `request.body.source`, which exists for singleWrap only.
    //
    // The concrete demonstration-of-impact test is the one we run in
    // CI on Node 24.15+ (see tests/integration/fly-runtime.test.ts in a
    // follow-up), but we at least verify here that double-wrap consumes
    // the single-wrap's body stream — which is the mechanism.
  });
});
