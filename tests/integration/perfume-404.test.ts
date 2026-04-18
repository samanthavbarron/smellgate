/**
 * Integration test for the scoped `/perfume/[uri]` 404 page (issue #123).
 *
 * The bug: when the page calls `notFound()` on a missing URI, Next.js
 * fell back to an empty internal 404, which in this app's layout strips
 * down to just the word "smellgate". The fix is a co-located
 * `app/perfume/[uri]/not-found.tsx` that Next.js auto-picks when
 * `notFound()` fires from the matching page.
 *
 * We can't easily spin up a full Next.js HTTP server inside Vitest, so
 * this test covers the two halves of the contract independently:
 *
 *   1. `page.tsx` throws `NEXT_NOT_FOUND` (the marker Next.js uses to
 *      produce the HTTP 404 response) when the perfume isn't in the
 *      cache. This is what actually drives the status code.
 *   2. `not-found.tsx` renders the user-facing copy the bug demanded —
 *      "Perfume not found", a back-home link, and the font-mono URI
 *      detail. Rendering it directly via `renderToString` is sufficient;
 *      Next.js runs the same render during its 404 fallback.
 *
 * Follows the seeding/module-isolation pattern from
 * `render-xss-regression.test.ts` and `perfumes-browse.test.ts`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

// `next/headers` is pulled in transitively; stub to an empty cookie
// store so `getSession()` short-circuits to anonymous.
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ get: () => undefined as { value?: string } | undefined }),
}));

// `not-found.tsx` is a client component that reads `usePathname()` to
// show which URI the user tried. Outside the Next.js runtime there's no
// pathname context, so we stub the hook directly — each test sets the
// return value before invoking the component.
let mockPathname: string | null = null;
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>(
    "next/navigation",
  );
  return {
    ...actual,
    usePathname: () => mockPathname,
  };
});

const FAKE_CURATOR_DID = "did:plc:perfume-404-curator";

type DbIndexModule = typeof import("../../lib/db");
type MigrationsModule = typeof import("../../lib/db/migrations");

interface Env {
  db: DbIndexModule;
  dispose: () => void;
}

async function freshEnv(): Promise<Env> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-perfume-404-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  vi.stubEnv("SMELLGATE_CURATOR_DIDS", FAKE_CURATOR_DID);
  vi.resetModules();

  const migrations: MigrationsModule = await import("../../lib/db/migrations");
  const { error } = await migrations.getMigrator().migrateToLatest();
  if (error) throw error;

  const db: DbIndexModule = await import("../../lib/db");
  return {
    db,
    dispose: () => {
      try {
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

describe("perfume detail 404 (#123)", () => {
  let env: Env;

  beforeEach(async () => {
    env = await freshEnv();
    mockPathname = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  it("page.tsx throws the Next.js HTTP 404 fallback for a URI missing from the cache", async () => {
    const PageModule = await import("../../app/perfume/[uri]/page");
    const PageComponent = PageModule.default as (props: {
      params: Promise<{ uri: string }>;
    }) => Promise<React.ReactElement>;

    const missingUri = `at://${FAKE_CURATOR_DID}/app.smellgate.perfume/doesnotexist`;

    // `notFound()` throws an error whose `digest` is the Next.js 16
    // HTTP-error-fallback marker `NEXT_HTTP_ERROR_FALLBACK;404`. That
    // `;404` suffix is what the Next.js runtime keys off to emit an
    // HTTP 404 response and swap in `not-found.tsx`. Asserting on it is
    // the closest we can get to asserting the HTTP status without
    // booting a full Next.js server.
    let thrown: unknown = null;
    try {
      await PageComponent({
        params: Promise.resolve({ uri: encodeURIComponent(missingUri) }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    const digest = (thrown as { digest?: string }).digest ?? "";
    expect(digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  }, 30_000);

  it("malformed (non-at-URI) segment also throws the HTTP 404 fallback", async () => {
    const PageModule = await import("../../app/perfume/[uri]/page");
    const PageComponent = PageModule.default as (props: {
      params: Promise<{ uri: string }>;
    }) => Promise<React.ReactElement>;

    let thrown: unknown = null;
    try {
      await PageComponent({
        params: Promise.resolve({ uri: "not-even-an-at-uri" }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    expect((thrown as { digest?: string }).digest ?? "").toBe(
      "NEXT_HTTP_ERROR_FALLBACK;404",
    );
  }, 30_000);

  it("not-found.tsx renders the recognizable marker + back-home link", async () => {
    mockPathname =
      "/perfume/at%3A%2F%2Fdid%3Aplc%3Asmellgate-dev-curator%2Fapp.smellgate.perfume%2Fdoesnotexist";
    const NotFoundModule = await import(
      "../../app/perfume/[uri]/not-found"
    );
    const NotFound =
      NotFoundModule.default as () => React.ReactElement;
    const html = renderToString(NotFound());

    // The marker copy the bug report wanted. Without this, the page is
    // the empty "just the word smellgate" from issue #123.
    expect(html).toContain("Perfume not found");
    // A way out — the home link.
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to home");
  });

  it("not-found.tsx surfaces the decoded URI the user tried", async () => {
    const triedAtUri =
      "at://did:plc:smellgate-dev-curator/app.smellgate.perfume/doesnotexist";
    // The browser URL has this encoded via `encodeURIComponent`; the
    // home page's `PerfumeTile` does the encoding, and the page route
    // preserves the encoding. Our `usePathname()` mock mirrors that.
    mockPathname = `/perfume/${encodeURIComponent(triedAtUri)}`;

    const NotFoundModule = await import(
      "../../app/perfume/[uri]/not-found"
    );
    const NotFound =
      NotFoundModule.default as () => React.ReactElement;
    const html = renderToString(NotFound());

    // The raw (decoded) AT-URI should be visible so a user with a
    // malformed paste can spot the issue. React escapes `/` in `at://…`
    // paths as-is (it's a safe char for text nodes), so the literal
    // substring will appear.
    expect(html).toContain(triedAtUri);
    // Rendered in a font-mono detail block, per the UI spec.
    expect(html).toContain("font-mono");
  });

  it("not-found.tsx degrades cleanly when usePathname returns null", async () => {
    mockPathname = null;
    const NotFoundModule = await import(
      "../../app/perfume/[uri]/not-found"
    );
    const NotFound =
      NotFoundModule.default as () => React.ReactElement;
    const html = renderToString(NotFound());

    // Even with no pathname context, the user still gets useful copy
    // and a way home — the URI detail is the bonus, not the main event.
    expect(html).toContain("Perfume not found");
    expect(html).toContain('href="/"');
  });
});
