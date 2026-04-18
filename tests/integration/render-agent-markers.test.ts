/**
 * Render-path integration test for issue #117.
 *
 * Guards the contract between `scripts/agent-as.ts`'s HTML summarizers
 * and the rendered DOM: the CLI scrapes for `data-smellgate-*` markers
 * on card elements, and before #117 no render path actually emitted
 * those markers, so every agent invocation reported zero reviews /
 * descriptions / shelf items.
 *
 * Strategy:
 *   1. Seed a perfume, a review, a description, and a shelf item via
 *      the same `dispatchSmellgateEvent` path the firehose uses.
 *   2. Render the relevant server components as plain async functions
 *      (same technique as `render-xss-regression.test.ts`).
 *   3. Parse the HTML with the exact same `__parsers.summarize*`
 *      helpers the CLI uses — we deliberately re-use the CLI's code
 *      rather than re-implementing the regex, because the whole point
 *      of the issue is that the CLI's parser and the DOM must stay in
 *      lock step.
 *
 * This is an integration test in the sense that it exercises the real
 * DB → queries → server component render pipeline end-to-end against
 * a freshly-migrated sqlite file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { RecordEvent } from "@atproto/tap";

import { __parsers } from "@/scripts/agent-as";

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ get: () => undefined as { value?: string } | undefined }),
}));
vi.mock("@/lib/db/queries", async () => {
  const actual = await vi.importActual<typeof import("../../lib/db/queries")>(
    "../../lib/db/queries",
  );
  return {
    ...actual,
    getAccountHandle: async (did: string) => did,
  };
});

const FAKE_CID = "bafkreic34bborvtv2pquhi5vt3yjjuhzdhmlnqx263wmc3br2fu63evfiy";
const FAKE_CURATOR_DID = "did:plc:marker-test-curator";
const FAKE_AUTHOR_DID = "did:plc:marker-test-author";

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
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-markers-")),
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

describe("agent-as CLI markers (#117)", () => {
  let env: Env;

  beforeEach(async () => {
    rkeyCounter = 0;
    env = await freshEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  it("perfume page emits data-smellgate-review + data-smellgate-description markers keyed by AT-URI", async () => {
    const perfumeRkey = nextRkey();
    const perfumeUri = `at://${FAKE_CURATOR_DID}/app.smellgate.perfume/${perfumeRkey}`;
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.perfume",
        FAKE_CURATOR_DID,
        {
          $type: "app.smellgate.perfume",
          name: "Marker Target",
          house: "TestHouse",
          notes: ["amber", "oud"],
          createdAt: nowIso(),
        },
        perfumeRkey,
      ),
    );

    const reviewRkey = nextRkey();
    const reviewUri = `at://${FAKE_AUTHOR_DID}/app.smellgate.review/${reviewRkey}`;
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.review",
        FAKE_AUTHOR_DID,
        {
          $type: "app.smellgate.review",
          perfume: { uri: perfumeUri, cid: FAKE_CID },
          rating: 7,
          sillage: 3,
          longevity: 4,
          body: "Smells like warm resin and cedar.",
          createdAt: nowIso(),
        },
        reviewRkey,
      ),
    );

    const descRkey = nextRkey();
    const descUri = `at://${FAKE_AUTHOR_DID}/app.smellgate.description/${descRkey}`;
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.description",
        FAKE_AUTHOR_DID,
        {
          $type: "app.smellgate.description",
          perfume: { uri: perfumeUri, cid: FAKE_CID },
          body: "Dries down to a soft powder.",
          createdAt: nowIso(),
        },
        descRkey,
      ),
    );

    const PageModule = await import("../../app/perfume/[uri]/page");
    const PageComponent = PageModule.default as (props: {
      params: Promise<{ uri: string }>;
    }) => Promise<React.ReactElement>;
    const element = await PageComponent({
      params: Promise.resolve({ uri: encodeURIComponent(perfumeUri) }),
    });
    const html = renderToString(element);

    const summary = __parsers.summarizePerfume(html);

    expect(summary.notes.sort()).toEqual(["amber", "oud"]);
    expect(summary.reviews).toHaveLength(1);
    expect(summary.reviews[0].uri).toBe(reviewUri);
    expect(summary.reviews[0].rating).toBe(7);
    expect(summary.reviews[0].snippet).toContain("warm resin");

    expect(summary.descriptions).toHaveLength(1);
    expect(summary.descriptions[0].uri).toBe(descUri);
    expect(summary.descriptions[0].snippet).toContain("soft powder");
  }, 60_000);

  it("profile page emits data-smellgate-shelf-item + review/description markers keyed by AT-URI", async () => {
    const perfumeRkey = nextRkey();
    const perfumeUri = `at://${FAKE_CURATOR_DID}/app.smellgate.perfume/${perfumeRkey}`;
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.perfume",
        FAKE_CURATOR_DID,
        {
          $type: "app.smellgate.perfume",
          name: "Profile Target",
          house: "ProfHouse",
          notes: ["iris"],
          createdAt: nowIso(),
        },
        perfumeRkey,
      ),
    );

    const shelfRkey = nextRkey();
    const shelfUri = `at://${FAKE_AUTHOR_DID}/app.smellgate.shelfItem/${shelfRkey}`;
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.shelfItem",
        FAKE_AUTHOR_DID,
        {
          $type: "app.smellgate.shelfItem",
          perfume: { uri: perfumeUri, cid: FAKE_CID },
          bottleSizeMl: 50,
          createdAt: nowIso(),
        },
        shelfRkey,
      ),
    );

    const reviewRkey = nextRkey();
    const reviewUri = `at://${FAKE_AUTHOR_DID}/app.smellgate.review/${reviewRkey}`;
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.review",
        FAKE_AUTHOR_DID,
        {
          $type: "app.smellgate.review",
          perfume: { uri: perfumeUri, cid: FAKE_CID },
          rating: 9,
          sillage: 5,
          longevity: 5,
          body: "Powdered iris at its best.",
          createdAt: nowIso(),
        },
        reviewRkey,
      ),
    );

    const descRkey = nextRkey();
    const descUri = `at://${FAKE_AUTHOR_DID}/app.smellgate.description/${descRkey}`;
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.description",
        FAKE_AUTHOR_DID,
        {
          $type: "app.smellgate.description",
          perfume: { uri: perfumeUri, cid: FAKE_CID },
          body: "Quiet, clean iris root.",
          createdAt: nowIso(),
        },
        descRkey,
      ),
    );

    const PageModule = await import("../../app/profile/[did]/page");
    const PageComponent = PageModule.default as (props: {
      params: Promise<{ did: string }>;
    }) => Promise<React.ReactElement>;
    const element = await PageComponent({
      params: Promise.resolve({ did: encodeURIComponent(FAKE_AUTHOR_DID) }),
    });
    const html = renderToString(element);

    const shelfSummary = __parsers.summarizeShelf(html);
    expect(shelfSummary.items).toHaveLength(1);
    expect(shelfSummary.items[0].uri).toBe(shelfUri);
    expect(shelfSummary.items[0].perfumeUri).toBe(perfumeUri);

    // Reviews & descriptions also appear on the profile with the same
    // markers — reuse the perfume summarizer's extraction logic.
    const reviewMatches = Array.from(
      __parsers.extractMarkedElements(html, "data-smellgate-review"),
    );
    expect(reviewMatches.map((e) => e.uri)).toEqual([reviewUri]);

    const descMatches = Array.from(
      __parsers.extractMarkedElements(html, "data-smellgate-description"),
    );
    expect(descMatches.map((e) => e.uri)).toEqual([descUri]);
  }, 60_000);

  it("home page emits data-smellgate-perfume + data-smellgate-review markers", async () => {
    const perfumeRkey = nextRkey();
    const perfumeUri = `at://${FAKE_CURATOR_DID}/app.smellgate.perfume/${perfumeRkey}`;
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.perfume",
        FAKE_CURATOR_DID,
        {
          $type: "app.smellgate.perfume",
          name: "Home Target",
          house: "HomeHouse",
          notes: ["bergamot"],
          createdAt: nowIso(),
        },
        perfumeRkey,
      ),
    );

    const reviewRkey = nextRkey();
    const reviewUri = `at://${FAKE_AUTHOR_DID}/app.smellgate.review/${reviewRkey}`;
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.review",
        FAKE_AUTHOR_DID,
        {
          $type: "app.smellgate.review",
          perfume: { uri: perfumeUri, cid: FAKE_CID },
          rating: 6,
          sillage: 2,
          longevity: 3,
          body: "Quick bergamot flash then gone.",
          createdAt: nowIso(),
        },
        reviewRkey,
      ),
    );

    const PageModule = await import("../../app/page");
    const PageComponent = PageModule.default as () => Promise<React.ReactElement>;
    const element = await PageComponent();
    const html = renderToString(element);

    const summary = __parsers.summarizeHome(html);
    expect(summary.perfumes).toContain(perfumeUri);
    expect(summary.reviews).toHaveLength(1);
    expect(summary.reviews[0].uri).toBe(reviewUri);
    expect(summary.reviews[0].rating).toBe(6);
    expect(summary.reviews[0].snippet).toContain("bergamot flash");
  }, 60_000);
});
