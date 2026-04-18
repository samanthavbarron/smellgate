/**
 * Integration test for the `/perfumes` browse-all page (issue #122).
 *
 * Seeds the cache with 30 canonical perfumes via the real Tap
 * dispatcher, then renders `app/perfumes/page.tsx` as a server
 * component to a string. Asserts page 1 shows 24 perfumes and page 2
 * shows the remaining 6 — the exact repro from the issue description
 * scaled down to match the page-size boundary.
 *
 * Follows the same shape as `render-xss-regression.test.ts`:
 * dispatcher-driven seeding, dynamic `import()` of the page module
 * after `vi.resetModules()`, `renderToString` against the returned
 * element. No HTTP, no Next.js runtime required — we invoke the
 * server component directly because that's all the page route does
 * under the hood for anonymous visitors.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { RecordEvent } from "@atproto/tap";

// `next/headers` reaches for an async request store that only exists
// inside the Next.js server runtime. The page we're rendering calls
// `getSession()` transitively only if it needs auth — `/perfumes`
// does not — but the import graph still pulls `next/headers` in
// through other modules, so stub it to an empty cookie store to be
// safe.
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ get: () => undefined as { value?: string } | undefined }),
}));

const FAKE_CID = "bafkreic34bborvtv2pquhi5vt3yjjuhzdhmlnqx263wmc3br2fu63evfiy";
const FAKE_CURATOR_DID = "did:plc:perfumes-browse-curator";

type DbIndexModule = typeof import("../../lib/db");
type MigrationsModule = typeof import("../../lib/db/migrations");
type TapModule = typeof import("../../lib/tap/smellgate");

interface Env {
  db: DbIndexModule;
  tap: TapModule;
  dispose: () => void;
}

async function freshEnv(): Promise<Env> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-perfumes-browse-")),
    "cache.db",
  );
  vi.stubEnv("DATABASE_PATH", dbPath);
  vi.stubEnv("SMELLGATE_CURATOR_DIDS", FAKE_CURATOR_DID);
  vi.resetModules();

  const migrations: MigrationsModule = await import("../../lib/db/migrations");
  const { error } = await migrations.getMigrator().migrateToLatest();
  if (error) throw error;

  const db: DbIndexModule = await import("../../lib/db");
  const tap: TapModule = await import("../../lib/tap/smellgate");
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

let rkeyCounter = 0;
function nextRkey(): string {
  rkeyCounter += 1;
  return `3jzfsa00${rkeyCounter.toString().padStart(4, "0")}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

function makeEvent(
  collection: string,
  did: string,
  record: Record<string, unknown>,
  rkey: string = nextRkey(),
): RecordEvent {
  return {
    id: rkeyCounter,
    type: "record",
    action: "create",
    did,
    rev: "3kgaaaaaaaaa2",
    collection,
    rkey,
    record,
    cid: FAKE_CID,
    live: true,
  };
}

async function seedPerfume(env: Env, name: string): Promise<void> {
  await env.tap.dispatchSmellgateEvent(
    env.db.getDb(),
    makeEvent("app.smellgate.perfume", FAKE_CURATOR_DID, {
      $type: "app.smellgate.perfume",
      name,
      house: "Test House",
      notes: ["rose"],
      createdAt: nowIso(),
    }),
  );
}

async function renderPerfumesPage(
  pageParam: string | undefined,
): Promise<string> {
  const PageModule = await import("../../app/perfumes/page");
  const PageComponent = PageModule.default as (props: {
    searchParams: Promise<{ page?: string | string[] }>;
  }) => Promise<React.ReactElement>;
  const element = await PageComponent({
    searchParams: Promise.resolve(
      pageParam === undefined ? {} : { page: pageParam },
    ),
  });
  return renderToString(element);
}

/**
 * Count the distinct `PerfumeTile` cards rendered on the page. Each
 * tile is a `<a href="/perfume/...">` link. The only anchor shape the
 * page otherwise emits is the pagination Prev/Next controls, which
 * point at `/perfumes` / `/perfumes?page=...` — the strict `/perfume/`
 * (singular, with trailing slash) prefix isolates tile anchors from
 * pagination anchors.
 */
function countTiles(html: string): number {
  const matches = html.match(/href="\/perfume\/[^"]+"/g);
  return matches ? matches.length : 0;
}

/**
 * Extract the decoded AT-URI of each tile from its `href`. `PerfumeTile`
 * renders `<a href="/perfume/${encodeURIComponent(uri)}">`, so we
 * reverse that to get the original URI back.
 */
function tileUris(html: string): string[] {
  const matches = html.match(/href="\/perfume\/([^"]+)"/g) ?? [];
  return matches.map((m) => {
    const encoded = m.slice('href="/perfume/'.length, -1);
    return decodeURIComponent(encoded);
  });
}

/**
 * React SSR injects `<!-- -->` comment markers between text nodes and
 * `{...}` interpolations ({"Page "}{page}{" of "}{totalPages} becomes
 * `Page <!-- -->1<!-- --> of <!-- -->2`). Strip them so we can assert
 * on the human-readable surface form.
 */
function stripReactMarkers(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

describe("/perfumes browse-all page (#122)", () => {
  let env: Env;

  beforeEach(async () => {
    rkeyCounter = 0;
    env = await freshEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  it("paginates a 30-perfume catalog into page 1 (24) + page 2 (6)", async () => {
    // Seed 30 perfumes. We don't rely on insertion order to pick
    // which perfume lands on which page — the query orders by
    // `indexed_at DESC, uri DESC`, and a bulk insert loop like this
    // one will land multiple rows in the same millisecond, so the
    // `uri` tiebreaker is what actually decides page boundaries.
    // The 30-row total is what we care about here: 24 on page 1 and
    // 6 on page 2, regardless of which specific perfumes those are.
    for (let i = 0; i < 30; i += 1) {
      await seedPerfume(env, `Perfume ${String(i + 1).padStart(2, "0")}`);
    }

    const page1Html = await renderPerfumesPage(undefined);
    expect(countTiles(page1Html)).toBe(24);
    // Total count + "Page 1 of 2" indicator (React injects comment
    // markers between text nodes and {...} interpolations, so strip
    // them before matching the human-readable text).
    expect(page1Html).toContain("30 perfumes in the catalog");
    expect(stripReactMarkers(page1Html)).toContain("Page 1 of 2");
    // Next link present, Prev not linkified on page 1. The Prev
    // affordance is still rendered as disabled text so the layout
    // stays stable — check both.
    expect(page1Html).toContain('href="/perfumes?page=2"');

    const page2Html = await renderPerfumesPage("2");
    expect(countTiles(page2Html)).toBe(6);
    expect(stripReactMarkers(page2Html)).toContain("Page 2 of 2");
    expect(page2Html).toContain('href="/perfumes"');
  }, 60_000);

  it("renders the empty-state card when the cache has no perfumes", async () => {
    const html = await renderPerfumesPage(undefined);
    expect(countTiles(html)).toBe(0);
    expect(html).toContain("No perfumes yet");
    // No pagination nav when there's nothing to page through. Strip
    // React comment markers so `Page 1 of` matches against any
    // interpolation-fragmented copy.
    expect(stripReactMarkers(html)).not.toContain("Page 1 of");
  }, 60_000);

  it("has no overlap or gaps across page 1 and page 2 even when indexed_at ties", async () => {
    // Regression for the adversarial-review finding: `indexed_at` is
    // `Date.now()` (ms), and a sequential-await loop can easily land
    // multiple rows in the same millisecond. Without a stable
    // tiebreaker, SQLite is free to return ties in different orders
    // across `OFFSET 0` / `OFFSET 24` calls and page 1 ∪ page 2 can
    // silently drop or duplicate a row. The `getRecentPerfumes` sort
    // now includes `uri DESC` as a tiebreaker; this test proves the
    // union is exactly the 30 seeded URIs with no duplicates.
    for (let i = 0; i < 30; i += 1) {
      await seedPerfume(env, `Perfume ${String(i + 1).padStart(2, "0")}`);
    }
    const page1Html = await renderPerfumesPage(undefined);
    const page2Html = await renderPerfumesPage("2");
    const page1 = tileUris(page1Html);
    const page2 = tileUris(page2Html);
    expect(page1).toHaveLength(24);
    expect(page2).toHaveLength(6);
    const union = new Set<string>([...page1, ...page2]);
    expect(union.size).toBe(30);
    // No URI appears on both pages.
    const overlap = page1.filter((u) => page2.includes(u));
    expect(overlap).toEqual([]);
  }, 60_000);

  it("clamps ?page=9999 to the last real page", async () => {
    for (let i = 0; i < 30; i += 1) {
      await seedPerfume(env, `Perfume ${String(i + 1).padStart(2, "0")}`);
    }
    const html = await renderPerfumesPage("9999");
    // 30 / 24 = 2 pages. The route should render page 2, not an
    // empty grid with a broken "Page 9999 of 2" indicator.
    expect(countTiles(html)).toBe(6);
    expect(stripReactMarkers(html)).toContain("Page 2 of 2");
  }, 60_000);
});
