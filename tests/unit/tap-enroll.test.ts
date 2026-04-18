/**
 * Unit tests for `lib/tap/enroll.ts` (issues #166, #190).
 *
 * We stub `global.fetch` and `process.env` to assert the helper POSTs to
 * the right URL with the right auth + body shape, and that it
 * soft-fails in every failure mode (network error, non-2xx, timeout,
 * unset env vars) without throwing.
 *
 * The integration contract — that `enrollInTap` is actually invoked
 * from the OAuth callback on successful login — is covered in the
 * OAuth integration test (`tests/integration/oauth-pds.test.ts`).
 * These unit tests pin the wire-format and failure-mode contracts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrollInTap } from "../../lib/tap/enroll";

const TEST_DID = "did:plc:testuser12345";

describe("enrollInTap", () => {
  beforeEach(() => {
    // Start each test with the env in a known state. `TAP_URL` and
    // `TAP_ADMIN_PASSWORD` are set per-test as needed.
    vi.stubEnv("TAP_URL", "");
    vi.stubEnv("TAP_ADMIN_PASSWORD", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is a no-op when TAP_URL is unset", async () => {
    vi.stubEnv("TAP_ADMIN_PASSWORD", "secret");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await enrollInTap(TEST_DID);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when TAP_ADMIN_PASSWORD is unset", async () => {
    vi.stubEnv("TAP_URL", "http://smellgate-tap.flycast:2480");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await enrollInTap(TEST_DID);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs to /repos/add with the correct auth header and body", async () => {
    vi.stubEnv("TAP_URL", "http://smellgate-tap.flycast:2480");
    vi.stubEnv("TAP_ADMIN_PASSWORD", "hunter2");
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await enrollInTap(TEST_DID);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://smellgate-tap.flycast:2480/repos/add");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    // "admin:hunter2" base64-encoded.
    expect(headers["Authorization"]).toBe(
      "Basic " + Buffer.from("admin:hunter2").toString("base64"),
    );

    // Tap expects a `dids` array, not a singular `did`.
    expect(JSON.parse(init.body as string)).toEqual({ dids: [TEST_DID] });

    // Timeout is wired via AbortSignal.timeout().
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("handles a trailing-slash TAP_URL correctly", async () => {
    // The URL constructor collapses `foo/` + `/repos/add` to
    // `foo/repos/add`, which is what we want. Assert the happy path.
    vi.stubEnv("TAP_URL", "http://smellgate-tap.flycast:2480/");
    vi.stubEnv("TAP_ADMIN_PASSWORD", "hunter2");
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await enrollInTap(TEST_DID);

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://smellgate-tap.flycast:2480/repos/add");
  });

  it("swallows non-2xx responses and warns (no throw)", async () => {
    vi.stubEnv("TAP_URL", "http://smellgate-tap.flycast:2480");
    vi.stubEnv("TAP_ADMIN_PASSWORD", "hunter2");
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(enrollInTap(TEST_DID)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("500");
    expect(msg).toContain(TEST_DID);
  });

  it("does NOT warn on 409 (already-enrolled)", async () => {
    vi.stubEnv("TAP_URL", "http://smellgate-tap.flycast:2480");
    vi.stubEnv("TAP_ADMIN_PASSWORD", "hunter2");
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 409 }));
    vi.stubGlobal("fetch", fetchSpy);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await enrollInTap(TEST_DID);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("swallows network errors and warns (no throw)", async () => {
    vi.stubEnv("TAP_URL", "http://smellgate-tap.flycast:2480");
    vi.stubEnv("TAP_ADMIN_PASSWORD", "hunter2");
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchSpy);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(enrollInTap(TEST_DID)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("ECONNREFUSED");
    expect(msg).toContain(TEST_DID);
  });

  it("swallows AbortError from the timeout and warns (no throw)", async () => {
    vi.stubEnv("TAP_URL", "http://smellgate-tap.flycast:2480");
    vi.stubEnv("TAP_ADMIN_PASSWORD", "hunter2");
    // Simulate the AbortSignal.timeout() path: fetch rejects with a
    // TimeoutError-shaped DOMException.
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    const fetchSpy = vi.fn().mockRejectedValue(timeoutErr);
    vi.stubGlobal("fetch", fetchSpy);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(enrollInTap(TEST_DID)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
