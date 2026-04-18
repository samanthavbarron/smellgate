import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression guard for the 2026-04-18 login hang.
 *
 * The production repro: once `client.restore(did)` inside
 * `@atproto/oauth-client` wedged, the stall leaked through
 * `getSession()` and every subsequent page render blocked on the same
 * stuck promise. See `lib/auth/session.ts` and `tests/e2e/oauth-login.spec.ts`.
 *
 * The unit coverage below locks in two properties of the fix:
 *   1. A `client.restore()` call that never resolves causes
 *      `getSession()` to resolve with `null` within the configured
 *      budget instead of hanging indefinitely.
 *   2. On timeout we invalidate the `NodeOAuthClient` singleton so a
 *      subsequent call rebuilds fresh state (flushing any leaked
 *      `CachedGetter.pending` / `requestLocalLock` entries).
 */

const restoreMock = vi.fn<(did: string) => Promise<unknown>>();
const resetMock = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "did" ? { name, value: "did:plc:testuser" } : undefined,
  }),
}));

vi.mock("../../lib/auth/client", () => ({
  getOAuthClient: async () => ({ restore: restoreMock }),
  resetOAuthClient: resetMock,
}));

// Import AFTER the mocks are registered.
let getSession: typeof import("../../lib/auth/session").getSession;

describe("getSession hard-timeout / reset guard", () => {
  beforeEach(async () => {
    restoreMock.mockReset();
    resetMock.mockReset();
    vi.useFakeTimers();
    // Force re-import against the freshly registered mocks.
    vi.resetModules();
    getSession = (await import("../../lib/auth/session")).getSession;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null and resets the client when restore never resolves", async () => {
    // A restore that never settles models the stuck-promise failure.
    let resolveRestore: ((v: unknown) => void) | null = null;
    restoreMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRestore = resolve;
      }),
    );

    const pending = getSession();
    // Advance past the 4s budget.
    await vi.advanceTimersByTimeAsync(4100);

    const result = await pending;
    expect(result).toBeNull();
    expect(resetMock).toHaveBeenCalledTimes(1);
    // Prevent the dangling promise from keeping the test alive.
    resolveRestore?.(null);
  });

  it("does not reset the client on a normal restore rejection", async () => {
    restoreMock.mockRejectedValueOnce(new Error("token refresh failed"));
    const result = await getSession();
    expect(result).toBeNull();
    expect(resetMock).not.toHaveBeenCalled();
  });
});
