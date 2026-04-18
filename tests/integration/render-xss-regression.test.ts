/**
 * Render-path regression test for issue #141.
 *
 * Complements the write-layer sanitization tests in
 * `server-actions.test.ts` with the other half of the defense: even
 * if an attacker's payload somehow reached the cache unsanitized
 * (e.g. a record written directly to a PDS bypassing our server
 * actions), the render paths must still escape it.
 *
 * Strategy:
 *   1. Seed the cache with a description row whose `body` carries a
 *      literal `<script>` + `<img onerror>` payload, via the same
 *      `dispatchSmellgateEvent` path the firehose uses — this is the
 *      worst case the bug-bash issue explicitly calls out: "whether or
 *      not the render path currently escapes this".
 *   2. Render `app/perfume/[uri]/page.tsx` as a server component to a
 *      string via `react-dom/server`. This is what the Next.js route
 *      runtime would do for an anonymous visitor.
 *   3. Assert that the rendered HTML contains the ENTITY-ESCAPED
 *      payload (`&lt;script&gt;`) and does NOT contain executable
 *      tags (`<script>` followed by `alert`).
 *
 * Audit findings (file-by-file sweep for #141):
 *
 *   - `app/perfume/[uri]/page.tsx` — clean. Renders `perfume.name`,
 *     `perfume.description`, `review.body`, `description.body`,
 *     `c.body` (comment), and note tags all via React text
 *     interpolation `{...}`. No `dangerouslySetInnerHTML`, no
 *     `innerHTML`, no markdown pipeline.
 *   - `app/profile/[did]/page.tsx` — clean. Renders handle, `did`,
 *     `review.body`, `description.body`, perfume metadata all via
 *     `{...}`. Same pattern as above.
 *   - `app/page.tsx` — clean. Renders `review.body` (snippet),
 *     `perfume.name`, `perfume.house`, `review.rating` all via
 *     `{...}`.
 *   - `components/PerfumeTile.tsx` — renders name / house / creator /
 *     notes via `{...}`.
 *   - `components/forms/VoteButtons.tsx` — doesn't render user text.
 *   - `components/curator/SubmissionCard.tsx` — already confirmed
 *     safe by the bug-bash curator (see issue #141 body).
 *
 * No `dangerouslySetInnerHTML` / `innerHTML` anywhere in the tree.
 * React's default text interpolation escapes, which is why this test
 * asserts on that escape rather than chasing a phantom unsafe
 * renderer.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { RecordEvent } from "@atproto/tap";

// `next/headers` reaches for an async request store that only exists
// inside the Next.js server runtime. Our render-regression test
// invokes the server component as a plain async function, outside
// that runtime, so we stub `cookies()` to return a store with no
// entries — equivalent to an anonymous visitor. `getSession()` then
// short-circuits to `null` because the `did` cookie is absent.
//
// `getAccountHandle` hits Tap's identity resolver; in tests there is
// no resolver, so we stub it to return the DID as-is. The exact
// handle string is irrelevant to this test — we're asserting on the
// BODY output (XSS payload escape), not the author line.
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
const FAKE_CURATOR_DID = "did:plc:render-test-curator";
const FAKE_AUTHOR_DID = "did:plc:render-test-author";

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
    fs.mkdtempSync(path.join(os.tmpdir(), "smellgate-render-")),
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

describe("render-path XSS regression (#141)", () => {
  let env: Env;

  beforeEach(async () => {
    rkeyCounter = 0;
    env = await freshEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    env.dispose();
  });

  it("escapes <script> and <img onerror> in a community description body when rendering the perfume page", async () => {
    // Seed a canonical perfume.
    const perfumeRkey = nextRkey();
    const perfumeUri = `at://${FAKE_CURATOR_DID}/app.smellgate.perfume/${perfumeRkey}`;
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.perfume",
        FAKE_CURATOR_DID,
        {
          $type: "app.smellgate.perfume",
          name: "Render Target",
          house: "House",
          notes: ["test"],
          createdAt: nowIso(),
        },
        perfumeRkey,
      ),
    );

    // Seed a community description whose body carries the XSS
    // payload VERBATIM — we're exercising the render path's escape,
    // not the write path's sanitizer.
    const xssBody =
      'Smells like <script>alert("xss")</script> pine needles and rain <img src=x onerror=alert(1)>.';
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.description",
        FAKE_AUTHOR_DID,
        {
          $type: "app.smellgate.description",
          perfume: { uri: perfumeUri, cid: FAKE_CID },
          body: xssBody,
          createdAt: nowIso(),
        },
      ),
    );

    // Dynamic-import the page component AFTER resetModules() so it
    // picks up our stubbed DATABASE_PATH. Next.js' server components
    // are plain async functions; we can invoke them directly and pass
    // a synthetic `params` Promise to mirror the route runtime.
    const PageModule = await import(
      "../../app/perfume/[uri]/page"
    );
    const PageComponent = PageModule.default as (props: {
      params: Promise<{ uri: string }>;
    }) => Promise<React.ReactElement>;

    // The real route wraps the URI in `encodeURIComponent` in the
    // href and decodes inside the page — we emulate that.
    const element = await PageComponent({
      params: Promise.resolve({ uri: encodeURIComponent(perfumeUri) }),
    });

    const html = renderToString(element);

    // Positive: the escaped form of the payload must appear in the
    // output (React default-escapes text interpolations). The
    // attacker's text is preserved as literal characters, just
    // entity-encoded so the browser treats them as text.
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    // The `onerror=` substring will appear literally inside the
    // escaped payload (`&lt;img src=x onerror=alert(1)&gt;`) — that's
    // fine because it's text, not an attribute. What we MUST NOT see
    // is an unescaped `<img ... onerror=...>` tag.

    // Negative: no executable tag sequences. The attacker payload
    // must never appear as real HTML. We specifically forbid:
    //   - `<script>alert` (an unescaped script open-tag + content)
    //   - a real `<img …onerror=…>` tag (an unescaped img with an
    //     event handler attribute).
    expect(html).not.toContain("<script>alert");
    expect(html).not.toMatch(/<img[^>]*onerror=[^>]*>/i);
    expect(html).not.toMatch(/<script[^>]*>/i);
  }, 60_000);

  it("escapes <script> and <img onerror> in a review body when rendering the perfume page", async () => {
    const perfumeRkey = nextRkey();
    const perfumeUri = `at://${FAKE_CURATOR_DID}/app.smellgate.perfume/${perfumeRkey}`;
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.perfume",
        FAKE_CURATOR_DID,
        {
          $type: "app.smellgate.perfume",
          name: "Review Render Target",
          house: "House",
          notes: ["test"],
          createdAt: nowIso(),
        },
        perfumeRkey,
      ),
    );

    const xssBody =
      'Great <script>alert("xss")</script> drydown <img src=x onerror=alert(1)>.';
    await env.tap.dispatchSmellgateEvent(
      env.db.getDb(),
      makeEvent(
        "app.smellgate.review",
        FAKE_AUTHOR_DID,
        {
          $type: "app.smellgate.review",
          perfume: { uri: perfumeUri, cid: FAKE_CID },
          rating: 8,
          sillage: 4,
          longevity: 4,
          body: xssBody,
          createdAt: nowIso(),
        },
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

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toMatch(/<img[^>]*onerror=[^>]*>/i);
    expect(html).not.toMatch(/<script[^>]*>/i);
  }, 60_000);
});
