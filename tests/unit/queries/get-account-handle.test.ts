/**
 * Unit tests for `getAccountHandle` (issue #109).
 *
 * The function has three resolution layers:
 *
 *   1. local `account` cache (Tap-populated read cache)
 *   2. Tap identity resolver (`getTap().resolveDid`)
 *   3. public PLC directory fallback (NEW — this is the #109 fix)
 *
 * These tests exercise all three plus their failure modes. Layers 1 and
 * 3 are the ones that meaningfully participate in the fix — layer 2 is
 * an existing fast path that still applies when Tap is attached.
 *
 * Uses the same pattern as `smellgate-queries.test.ts`: real SQLite
 * against a per-test tmpdir DB, `vi.resetModules` so each test gets a
 * freshly-migrated instance. No mocked DB.
 *
 * `global.fetch` is stubbed per-test so we can assert on call count,
 * simulate 404 / network errors / timeouts without hitting the real
 * `https://plc.directory`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueriesModule = typeof import("../../../lib/db/queries");
type DbIndexModule = typeof import("../../../lib/db");
type MigrationsModule = typeof import("../../../lib/db/migrations");
type TapModule = typeof import("../../../lib/tap");

const TEST_DID = "did:plc:testaccount1234";
const TEST_HANDLE = "alice.test";

interface Env {
  q: QueriesModule;
  db: DbIndexModule;
  tap: TapModule;
  dispose: () => void;
}

async function freshEnv(): Promise<Env> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-get-handle-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  // Default: no dev-network override, so the public PLC URL is
  // `https://plc.directory`. We never actually hit it — `fetch` is
  // stubbed on each test.
  vi.stubEnv("SMELLGATE_DEV_PLC_URL", "");
  vi.resetModules();

  const migrations: MigrationsModule = await import(
    "../../../lib/db/migrations"
  );
  const { error } = await migrations.getMigrator().migrateToLatest();
  if (error) throw error;

  const db: DbIndexModule = await import("../../../lib/db");
  const tap: TapModule = await import("../../../lib/tap");
  const q: QueriesModule = await import("../../../lib/db/queries");
  return {
    q,
    db,
    tap,
    dispose: () => {
      try {
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * Mock the Tap client's `resolveDid` for the current test. The module is
 * a singleton lazy-initialized inside `lib/tap/index.ts`, so we reach
 * into `getTap()` and overwrite the method. Called after `freshEnv`.
 */
function stubTapResolveDid(
  tap: TapModule,
  impl: (did: string) => Promise<unknown>,
): void {
  const client = tap.getTap() as unknown as {
    resolveDid: (did: string) => Promise<unknown>;
  };
  client.resolveDid = impl;
}

describe("getAccountHandle (#109 fallback)", () => {
  let env: Env;

  beforeEach(async () => {
    env = await freshEnv();
  });

  afterEach(() => {
    env.dispose();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cache hit — returns cached handle and does NOT touch Tap or fetch", async () => {
    // Pre-seed the `account` cache like Tap would have.
    await env.db.getDb().insertInto("account").values({
      did: TEST_DID,
      handle: TEST_HANDLE,
      active: 1,
    }).execute();

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const tapSpy = vi.fn();
    stubTapResolveDid(env.tap, tapSpy);

    const result = await env.q.getAccountHandle(TEST_DID);
    expect(result).toBe(TEST_HANDLE);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tapSpy).not.toHaveBeenCalled();
  });

  it("cache miss → Tap hit — returns Tap-resolved handle, writes through to cache, no public fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    stubTapResolveDid(env.tap, async () => ({
      id: TEST_DID,
      alsoKnownAs: [`at://${TEST_HANDLE}`],
      verificationMethod: [],
      service: [],
    }));

    const result = await env.q.getAccountHandle(TEST_DID);
    expect(result).toBe(TEST_HANDLE);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Write-through: the next call hits the cache and skips both Tap
    // and the public fallback.
    const row = await env.db
      .getDb()
      .selectFrom("account")
      .select(["handle", "active"])
      .where("did", "=", TEST_DID)
      .executeTakeFirst();
    expect(row).toEqual({ handle: TEST_HANDLE, active: 1 });
  });

  it("cache miss + Tap miss → public PLC hit — returns handle AND writes through to cache", async () => {
    // Tap returns null (not subscribed to this DID).
    stubTapResolveDid(env.tap, async () => null);

    // Public PLC directory returns a valid DID doc.
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      expect(u).toContain(encodeURIComponent(TEST_DID));
      return new Response(
        JSON.stringify({
          id: TEST_DID,
          alsoKnownAs: [`at://${TEST_HANDLE}`],
          verificationMethod: [],
          service: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await env.q.getAccountHandle(TEST_DID);
    expect(result).toBe(TEST_HANDLE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Write-through: same DID on next call should skip network.
    const row = await env.db
      .getDb()
      .selectFrom("account")
      .select(["handle", "active"])
      .where("did", "=", TEST_DID)
      .executeTakeFirst();
    expect(row).toEqual({ handle: TEST_HANDLE, active: 1 });

    fetchSpy.mockClear();
    const second = await env.q.getAccountHandle(TEST_DID);
    expect(second).toBe(TEST_HANDLE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cache miss + Tap throws → public PLC hit — Tap errors fall through to the public fallback", async () => {
    stubTapResolveDid(env.tap, async () => {
      throw new Error("TAP_URL unreachable");
    });

    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: TEST_DID,
            alsoKnownAs: [`at://${TEST_HANDLE}`],
            verificationMethod: [],
            service: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await env.q.getAccountHandle(TEST_DID);
    expect(result).toBe(TEST_HANDLE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("cache miss + Tap miss + public 404 → returns null, no cache write", async () => {
    stubTapResolveDid(env.tap, async () => null);

    const fetchSpy = vi.fn(
      async () => new Response("not found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await env.q.getAccountHandle(TEST_DID);
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const row = await env.db
      .getDb()
      .selectFrom("account")
      .selectAll()
      .where("did", "=", TEST_DID)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it("cache miss + Tap miss + network error → returns null", async () => {
    stubTapResolveDid(env.tap, async () => null);

    const fetchSpy = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await env.q.getAccountHandle(TEST_DID);
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("cache miss + Tap miss + fetch aborts (timeout) → returns null", async () => {
    stubTapResolveDid(env.tap, async () => null);

    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      // Simulate a caller-triggered abort (which is what our
      // `AbortController` timeout does).
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    // Trigger the abort ourselves by wrapping the call in a Promise
    // race that aborts via a short timeout on the fetch's signal is
    // owned by the implementation; instead, assert that a
    // pending-then-aborted fetch (raised by the implementation's own
    // timeout) resolves to null. Easiest: use fake timers.
    vi.useFakeTimers();
    const p = env.q.getAccountHandle(TEST_DID);
    // Advance past the 3s internal timeout.
    await vi.advanceTimersByTimeAsync(3100);
    const result = await p;
    vi.useRealTimers();
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("honors SMELLGATE_DEV_PLC_URL when set (dev-network routing)", async () => {
    // Re-bootstrap env with the dev-network PLC URL pointing at a fake
    // local PLC. The fetch stub asserts the implementation went there
    // and not to `plc.directory`.
    env.dispose();
    const dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-get-handle-dev-")),
      "cache.db",
    );
    vi.stubEnv("DATABASE_PATH", dbPath);
    vi.stubEnv("SMELLGATE_DEV_PLC_URL", "http://localhost:12345");
    vi.resetModules();

    const migrations: MigrationsModule = await import(
      "../../../lib/db/migrations"
    );
    const { error } = await migrations.getMigrator().migrateToLatest();
    if (error) throw error;
    const db: DbIndexModule = await import("../../../lib/db");
    const tap: TapModule = await import("../../../lib/tap");
    const q: QueriesModule = await import("../../../lib/db/queries");

    stubTapResolveDid(tap, async () => null);

    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      expect(u.startsWith("http://localhost:12345/")).toBe(true);
      expect(u).not.toContain("plc.directory");
      return new Response(
        JSON.stringify({
          id: TEST_DID,
          alsoKnownAs: [`at://${TEST_HANDLE}`],
          verificationMethod: [],
          service: [],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await q.getAccountHandle(TEST_DID);
    expect(result).toBe(TEST_HANDLE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Clean up this ad-hoc env.
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    // Cache the cleanup so the outer afterEach's dispose doesn't
    // double-delete; env.dispose is already no-op after the first.
    void db;
  });
});
