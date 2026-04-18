/**
 * Integration test for the `/perfume/[uri]` not-found rendering
 * (issues #123, #175).
 *
 * Regression history:
 *   - #123: bogus URI hit `notFound()` and fell through the app
 *     layout to a nearly-empty body. PR #156 added the scoped
 *     `not-found.tsx`.
 *   - #175: on production the PR #156 fix still rendered
 *     `<html id="__next_error__">` with an empty `<body>` — Next.js
 *     16's mid-stream `notFound()` bailout. The fix in this PR makes
 *     `page.tsx` render `PerfumeNotFound` *inline* instead of calling
 *     `notFound()`. The inline path produces a proper body that
 *     ships without relying on client-side hydration.
 *
 * This test covers both:
 *   1. The `not-found.tsx` component renders its markers in isolation
 *      (preserved from #123).
 *   2. `page.tsx` returns the same UI inline when the cache has no
 *      row for the requested URI (the #175 regression target).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import NotFound from "../../app/perfume/[uri]/not-found";

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ get: () => undefined as { value?: string } | undefined }),
}));

type DbIndexModule = typeof import("../../lib/db");
type MigrationsModule = typeof import("../../lib/db/migrations");

async function freshEnv() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-perfume-404-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  vi.resetModules();
  const migrations: MigrationsModule = await import(
    "../../lib/db/migrations"
  );
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

describe("perfume detail not-found (#123, #175)", () => {
  it("the scoped `not-found.tsx` component renders the marker + back-home link", () => {
    const html = renderToString(NotFound());

    expect(html).toContain("Perfume not found");
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to home");
  });

  it("page.tsx renders the not-found UI inline when the perfume URI is not in the cache (#175)", async () => {
    const env = await freshEnv();
    try {
      const PageModule = await import("../../app/perfume/[uri]/page");
      const PageComponent = PageModule.default as (props: {
        params: Promise<{ uri: string }>;
      }) => Promise<React.ReactElement>;

      const element = await PageComponent({
        params: Promise.resolve({
          uri: encodeURIComponent("at://did:plc:bogus/app.smellgate.perfume/x"),
        }),
      });
      const html = renderToString(element);

      // The inline render IS the scoped not-found UI — no mid-stream
      // `notFound()` bailout. The "Perfume not found" marker has to
      // be in the returned body, not only in an RSC payload that
      // requires client JS to see.
      expect(html).toContain("Perfume not found");
      expect(html).toContain("Back to home");
      expect(html).toContain('href="/"');
    } finally {
      vi.unstubAllEnvs();
      env.dispose();
    }
  }, 30_000);
});
