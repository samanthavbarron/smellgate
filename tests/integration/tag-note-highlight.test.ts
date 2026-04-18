/**
 * Integration test for `/tag/note/<note>` tile highlighting (#120).
 *
 * Regression for the bug where each tile's visible 3-chip slice was
 * the first three notes alphabetically — so on `/tag/note/vetiver`
 * tiles routinely did NOT show vetiver at all, and the filter
 * appeared broken from the user's perspective.
 *
 * Seeds 3 canonical perfumes that all share the note `vetiver` plus
 * other notes that sort before it alphabetically. Renders the
 * `/tag/note/[note]` server component directly (the route runtime's
 * only per-request work is the dynamic-segment decode + query). Each
 * tile's rendered HTML must contain `vetiver` among its chips.
 *
 * Mirrors the shape of `perfumes-browse.test.ts` — dispatcher-driven
 * seeding, `vi.resetModules()` + dynamic `import()` so the page picks
 * up our stubbed `DATABASE_PATH`, and `renderToString` against the
 * returned element.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { RecordEvent } from "@atproto/tap";

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ get: () => undefined as { value?: string } | undefined }),
}));

const FAKE_CID = "bafkreic34bborvtv2pquhi5vt3yjjuhzdhmlnqx263wmc3br2fu63evfiy";
const FAKE_CURATOR_DID = "did:plc:tag-highlight-curator";

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
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-tag-highlight-")),
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

async function seedPerfume(
  env: Env,
  name: string,
  notes: string[],
): Promise<void> {
  await env.tap.dispatchSmellgateEvent(
    env.db.getDb(),
    makeEvent("app.smellgate.perfume", FAKE_CURATOR_DID, {
      $type: "app.smellgate.perfume",
      name,
      house: "Test House",
      notes,
      createdAt: nowIso(),
    }),
  );
}

async function renderNoteTagPage(note: string): Promise<string> {
  const PageModule = await import("../../app/tag/note/[note]/page");
  const PageComponent = PageModule.default as (props: {
    params: Promise<{ note: string }>;
  }) => Promise<React.ReactElement>;
  const element = await PageComponent({
    params: Promise.resolve({ note: encodeURIComponent(note) }),
  });
  return renderToString(element);
}

/**
 * Slice the rendered HTML into one substring per tile so we can
 * assert per-tile that each one contains the highlighted note. A
 * tile is the `<a href="/perfume/...">...</a>` anchor emitted by
 * `PerfumeTile`. We use a regex that captures up to the closing
 * `</a>` — the tile's inner markup doesn't include nested anchors
 * (it's all `<div>` / `<span>`), so greedy-to-`</a>` is safe.
 */
function extractTiles(html: string): string[] {
  const re = /<a [^>]*href="\/perfume\/[^"]+"[^>]*>[\s\S]*?<\/a>/g;
  return html.match(re) ?? [];
}

describe("/tag/note/<note> tile highlight (#120)", () => {
  let env: Env;

  beforeEach(async () => {
    rkeyCounter = 0;
    env = await freshEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  it("shows the matched note on every tile, even when other notes sort before it alphabetically", async () => {
    // Each of these perfumes has `vetiver` plus 3-4 other notes that
    // all sort before `vetiver` alphabetically. Under the old
    // `notes.slice(0, 3)` behavior, zero tiles would show vetiver —
    // exactly the bug in the issue repro.
    await seedPerfume(env, "Boulot d'Hiver", [
      "birch",
      "pine needle",
      "smoke",
      "tar",
      "vetiver",
    ]);
    await seedPerfume(env, "Ardoise Mouillee", [
      "geosmin",
      "grey amber",
      "iris root",
      "vetiver",
      "wet slate",
    ]);
    await seedPerfume(env, "Ciboulette", [
      "carrot top",
      "chive",
      "green pepper",
      "moss",
      "vetiver",
    ]);

    const html = await renderNoteTagPage("vetiver");
    const tiles = extractTiles(html);
    expect(tiles).toHaveLength(3);
    for (const tile of tiles) {
      // Every tile must render `vetiver` as one of its visible chips
      // — the user's mental model ("I clicked vetiver, I should see
      // vetiver on every tile") must hold.
      expect(tile).toContain("vetiver");
    }
    // The header should also render "vetiver" — separate concern,
    // but it's a nice sanity check that the route wiring itself
    // works.
    expect(html).toContain("vetiver");
  }, 60_000);
});
