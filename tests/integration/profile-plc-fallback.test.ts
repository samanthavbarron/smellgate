/**
 * Integration test for issue #109: `/profile/<foreign-did>` must render
 * (not 404) when the Tap identity cache is empty and the local account
 * cache has no row for the DID, as long as the DID resolves against
 * the public PLC directory.
 *
 * The fix adds a public-PLC fallback inside `getAccountHandle`. This
 * test drives the profile page as a server component with:
 *
 *   - an empty local `account` cache
 *   - a stubbed Tap resolver that returns `null` (no subscription)
 *   - a stubbed `fetch` that answers the PLC directory URL with a
 *     valid DID doc containing the expected handle
 *
 * and asserts the rendered HTML contains the resolved handle AND the
 * page did not call `notFound()`. Then it runs the same page a second
 * time with a silent fetch spy and asserts write-through: the handle
 * came from the cache, no second network call.
 *
 * We do NOT stand up an in-process PDS for this test — the whole point
 * of the fix is that we can resolve a DID without one. The profile
 * page's cache queries (shelf, reviews, descriptions) run against
 * the local SQLite cache, which is empty in this scenario.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

// Anonymous visitor: `getSession()` short-circuits to `null` because
// the `did` cookie is absent.
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ get: () => undefined as { value?: string } | undefined }),
}));

// Route both Tap + the public PLC fallback deterministically.
const FOREIGN_DID = "did:plc:foreigner000000";
const FOREIGN_HANDLE = "foreigner.test";

type DbIndexModule = typeof import("../../lib/db");
type MigrationsModule = typeof import("../../lib/db/migrations");
type TapIndexModule = typeof import("../../lib/tap");

interface Env {
  db: DbIndexModule;
  tap: TapIndexModule;
  dispose: () => void;
}

async function freshEnv(): Promise<Env> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-profile-plc-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  // Force the fallback to hit a stable URL we can match in the fetch
  // stub — this mimics a dev-network run.
  vi.stubEnv("SMELLGATE_DEV_PLC_URL", "http://localhost:65535");
  vi.resetModules();

  const migrations: MigrationsModule = await import("../../lib/db/migrations");
  const { error } = await migrations.getMigrator().migrateToLatest();
  if (error) throw error;

  const db: DbIndexModule = await import("../../lib/db");
  const tap: TapIndexModule = await import("../../lib/tap");
  // Neutralize Tap: no identity cache, no subscription. Forces the
  // public-PLC fallback path.
  (tap.getTap() as unknown as {
    resolveDid: (did: string) => Promise<unknown>;
  }).resolveDid = async () => null;

  return {
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

describe("profile PLC fallback (#109)", () => {
  let env: Env;

  beforeEach(async () => {
    env = await freshEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    env.dispose();
  });

  it("renders a foreign-DID profile with the resolved handle when Tap is empty but PLC has the DID", async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      expect(u).toContain(encodeURIComponent(FOREIGN_DID));
      return new Response(
        JSON.stringify({
          id: FOREIGN_DID,
          alsoKnownAs: [`at://${FOREIGN_HANDLE}`],
          verificationMethod: [],
          service: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const PageModule = await import("../../app/profile/[did]/page");
    const PageComponent = PageModule.default as (props: {
      params: Promise<{ did: string }>;
    }) => Promise<React.ReactElement>;

    const element = await PageComponent({
      params: Promise.resolve({ did: encodeURIComponent(FOREIGN_DID) }),
    });
    const html = renderToString(element);

    // The page did not call `notFound()` (we got HTML back). The
    // resolved handle must appear in the header.
    expect(html).toContain(`@${FOREIGN_HANDLE}`);
    expect(html).toContain(FOREIGN_DID);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Write-through: second render must not hit `fetch` again.
    fetchSpy.mockClear();
    const element2 = await PageComponent({
      params: Promise.resolve({ did: encodeURIComponent(FOREIGN_DID) }),
    });
    const html2 = renderToString(element2);
    expect(html2).toContain(`@${FOREIGN_HANDLE}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("still 404s a foreign DID when Tap is empty AND the PLC directory has no record", async () => {
    const fetchSpy = vi.fn(
      async () => new Response("not found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const PageModule = await import("../../app/profile/[did]/page");
    const PageComponent = PageModule.default as (props: {
      params: Promise<{ did: string }>;
    }) => Promise<React.ReactElement>;

    // `notFound()` throws a `NEXT_NOT_FOUND` error — this is the
    // Next.js runtime convention for server components that call it.
    await expect(
      PageComponent({
        params: Promise.resolve({ did: encodeURIComponent(FOREIGN_DID) }),
      }),
    ).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  }, 30_000);
});
