/**
 * End-to-end regression test for the production 500 bug (Fly trace
 * 2026-04-18T03:15:50Z). Demonstrates that a DPoP-style Request passed
 * through a Next.js-patched fetch crashes on Node 24.15+ undici 7 with
 *   `TypeError: fetch failed` / `expected non-null body source`
 * and that wiring the OAuth client's `fetch` option to the pre-patch
 * fetch (via `_nextOriginalFetch`) makes it succeed.
 *
 * Why an integration test rather than a unit test: the failing branch
 * is inside Node's bundled undici, only triggers on a response with
 * status 401 + WWW-Authenticate, and is gated on the Request having a
 * ReadableStream body whose `source` is null. Reproducing all three at
 * once needs a real HTTP server, the double-wrap that Next's patch does,
 * and the actual DPoP-style Request shape. Doing it in a unit test with
 * mocked fetches won't hit the undici path we care about.
 *
 * Skip behavior: on Node versions that don't ship the buggy undici
 * (notably 24.11 and earlier), the "fails without fix" case doesn't
 * throw, so the assertion that demonstrates the bug is a no-op. We don't
 * hard-skip because the "succeeds with fix" case is still useful cover
 * on any Node version. The production gate is Node 24.15+ on Fly alpine,
 * which this CI's `actions/setup-node@v4 node-version: '24'` tracks.
 */

import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Reproduce Next.js's `patch-fetch.js`'s `doOriginalFetch` shape: given
// a Request input, it rebuilds a fresh Request from the input's properties,
// inheriting the `body` (a ReadableStream by that point).
function createNextPatchedFetch(
  originFetch: typeof fetch,
): typeof fetch & { _nextOriginalFetch: typeof fetch } {
  const patched = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const isRequestInput =
      input !== null &&
      typeof input === "object" &&
      "method" in input &&
      typeof (input as Request).method === "string";
    if (isRequestInput) {
      const reqInput = input as Request;
      const reqOptions: RequestInit = {
        body: reqInput.body,
        cache: reqInput.cache,
        credentials: reqInput.credentials,
        headers: reqInput.headers,
        integrity: reqInput.integrity,
        keepalive: reqInput.keepalive,
        method: reqInput.method,
        mode: reqInput.mode,
        redirect: reqInput.redirect,
        referrer: reqInput.referrer,
        referrerPolicy: reqInput.referrerPolicy,
        signal: reqInput.signal,
        // @ts-expect-error Node-specific when body is a stream
        duplex: "half",
      };
      input = new Request(reqInput.url, reqOptions);
    }
    return originFetch(input as RequestInfo | URL, init);
  }) as typeof fetch & { _nextOriginalFetch: typeof fetch };
  patched._nextOriginalFetch = originFetch;
  return patched;
}

// Reproduce `@atproto/oauth-client`'s dpopFetchWrapper shape: given
// (input, init), build a Request and call the downstream fetch.
function createDpopFetch(downstream: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      init == null && input instanceof Request
        ? input
        : new Request(input, init);
    request.headers.set("DPoP", "fake.dpop.proof.not.validated");
    return downstream(request);
  };
}

describe("fly-runtime DPoP regression (#squash-shelf-500)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Small local server that returns 401 with a DPoP WWW-Authenticate
    // header — the normal PDS response to a request missing a nonce.
    // This triggers undici 7's Fetch-spec 401-retry path, which is the
    // code that calls `safelyExtractBody(request.body.source)` and fails
    // when `source` is null.
    server = http.createServer((req, res) => {
      res.setHeader(
        "WWW-Authenticate",
        'DPoP realm="PDS", error="use_dpop_nonce"',
      );
      res.setHeader("DPoP-Nonce", "test-nonce-12345");
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "use_dpop_nonce" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no addr");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetch-with-fix: DPoP wrapper over unpatched fetch returns the 401", async () => {
    // With the fix in place, the DPoP wrapper's `new Request(...)` is
    // the only Request wrap — its body still has a string source. The
    // 401 response is returned as-is and the DPoP code can read the
    // body/header without hitting undici's re-extract path.
    const patched = createNextPatchedFetch(globalThis.fetch);
    const unpatched = patched._nextOriginalFetch;
    const dpopFetch = createDpopFetch(unpatched);
    const res = await dpopFetch(`${baseUrl}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "DPoP eyJabc.fake.token",
      },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(401);
    // Confirm WWW-Authenticate came through intact — this is the header
    // dpopFetchWrapper reads to decide whether to retry with a nonce.
    expect(res.headers.get("WWW-Authenticate")).toContain("use_dpop_nonce");
  });

  it("fetch-without-fix: DPoP wrapper over Next-patched fetch fails on Node 24.15+ undici 7", async () => {
    // This is the failing shape (pre-fix). On Node 24.15+ / undici 7,
    // the 401 with credentials (Authorization header) + ReadableStream
    // body (no source) triggers `expected non-null body source`. On
    // earlier Node/undici it silently passes. We accept both outcomes
    // to keep the test portable but assert that IF it throws, the
    // error shape matches the production trace.
    const patched = createNextPatchedFetch(globalThis.fetch);
    const dpopFetch = createDpopFetch(patched);
    try {
      const res = await dpopFetch(
        `${baseUrl}/xrpc/com.atproto.repo.createRecord`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "DPoP eyJabc.fake.token",
          },
          body: JSON.stringify({ hello: "world" }),
        },
      );
      // On pre-24.15 Node (local Codespace), this path still works —
      // the bug is version-gated. Passing is acceptable; we're
      // documenting the failure shape for the version where it
      // triggers.
      expect(res.status).toBe(401);
    } catch (err) {
      // If we hit the production failure mode, verify it matches the
      // exact trace from the 2026-04-18 Fly logs: fetch failed / cause
      // "expected non-null body source". Any other error is a different
      // bug and should be surfaced.
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toContain("fetch failed");
      const cause = (err as Error & { cause?: Error }).cause;
      expect(cause?.message).toContain("expected non-null body source");
    }
  });
});
