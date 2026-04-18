/**
 * Integration test for the OAuth callback → Tap enrollment wire-up
 * (issues #166, #190).
 *
 * This is intentionally narrower than `oauth-pds.test.ts` — we mock
 * `getOAuthClient` so we don't need a live PDS, because what's under
 * test is not the OAuth dance (already exercised end-to-end in the
 * other test) but rather the "after a successful callback, the
 * session's DID is enrolled with smellgate-tap" contract.
 *
 * We stub:
 *   - `getOAuthClient` → returns a fake client whose `callback()`
 *     resolves to a session with a known DID.
 *   - `rewritePendingRecords` → no-op (not under test; covered in the
 *     curator flow tests).
 *   - `global.fetch` → captures the POST to `/repos/add` so we can
 *     assert on its wire format, or rejects so we can assert login
 *     still completes.
 *
 * We then GET the real route handler and assert the response plus the
 * captured fetch calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TEST_DID = "did:plc:oauthcallbacktest";

// Mock the OAuth client module before importing the route. Vitest's
// module mock is hoisted so this runs before any `import` below.
vi.mock("@/lib/auth/client", () => ({
  getOAuthClient: vi.fn(),
}));

// Mock the rewrite step — it makes its own PDS calls and is covered
// elsewhere. Default to a no-op success; individual tests can rewire.
vi.mock("@/lib/server/smellgate-curator-actions", () => ({
  rewritePendingRecords: vi.fn().mockResolvedValue(undefined),
}));

// Point getDb at an in-memory sqlite and migrate before importing the
// route — `rewritePendingRecords` is mocked away so this DB is unused
// in practice, but the module still does `getDb()` on each call.
beforeEach(async () => {
  vi.stubEnv("DATABASE_PATH", ":memory:");
  vi.stubEnv("TAP_URL", "http://smellgate-tap.flycast:2480");
  vi.stubEnv("TAP_ADMIN_PASSWORD", "hunter2");
  vi.stubEnv("PUBLIC_URL", "https://smellgate.example.com");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OAuth callback → Tap enrollment", () => {
  it("POSTs the session DID to Tap /repos/add after a successful callback", async () => {
    const callbackMock = vi.fn().mockResolvedValue({
      session: { did: TEST_DID },
    });
    const { getOAuthClient } = await import("@/lib/auth/client");
    vi.mocked(getOAuthClient).mockResolvedValue({
      callback: callbackMock,
    } as unknown as Awaited<ReturnType<typeof getOAuthClient>>);

    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const { GET } = await import("@/app/oauth/callback/route");
    const req = new NextRequest(
      "https://smellgate.example.com/oauth/callback?code=abc&state=xyz&iss=http://pds",
    );
    const res = await GET(req);

    // Callback succeeded → redirect to `/`.
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://smellgate.example.com/");
    // `did` cookie set for the authenticated session.
    expect(res.cookies.get("did")?.value).toBe(TEST_DID);

    // Tap enrollment fired with the right DID + wire format.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://smellgate-tap.flycast:2480/repos/add");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ dids: [TEST_DID] });
  });

  it("still completes login when Tap enrollment fails", async () => {
    const callbackMock = vi.fn().mockResolvedValue({
      session: { did: TEST_DID },
    });
    const { getOAuthClient } = await import("@/lib/auth/client");
    vi.mocked(getOAuthClient).mockResolvedValue({
      callback: callbackMock,
    } as unknown as Awaited<ReturnType<typeof getOAuthClient>>);

    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchSpy);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { GET } = await import("@/app/oauth/callback/route");
    const req = new NextRequest(
      "https://smellgate.example.com/oauth/callback?code=abc&state=xyz&iss=http://pds",
    );
    const res = await GET(req);

    // Redirect and cookie happen regardless of Tap outcome — the
    // whole point of the soft-fail is that login experience is
    // unaffected by Tap being down.
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://smellgate.example.com/");
    expect(res.cookies.get("did")?.value).toBe(TEST_DID);

    // Warning got logged so an operator can debug.
    expect(warnSpy).toHaveBeenCalled();
    const anyTapWarn = warnSpy.mock.calls.some(
      (args) => typeof args[0] === "string" && args[0].includes("[tap]"),
    );
    expect(anyTapWarn).toBe(true);
  });
});
