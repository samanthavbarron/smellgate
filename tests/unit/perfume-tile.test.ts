/**
 * Unit test for `PerfumeTile`'s `highlight` prop (#120).
 *
 * The tag page (`/tag/note/<note>`) used to pick the first three notes
 * alphabetically for each tile, which meant the clicked tag often
 * wasn't visible on any tile — breaking the mental model of "I
 * clicked vetiver, these tiles all have vetiver". The `highlight`
 * prop guarantees the matched note is pinned first among the three
 * visible chips.
 *
 * We render the tile directly via `react-dom/server`'s
 * `renderToString` rather than spinning up the full Next.js runtime.
 * `next/link` degrades to a plain `<a>` under SSR, so no mock needed.
 *
 * Written as a `.test.ts` (not `.test.tsx`) because `vitest.config.ts`
 * only includes `*.test.ts` — using `React.createElement` keeps us
 * within that include pattern without a config change.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PerfumeTile } from "@/components/PerfumeTile";
import type { PerfumeWithNotes } from "@/lib/db/smellgate-queries";

function makePerfume(overrides: Partial<PerfumeWithNotes> = {}): PerfumeWithNotes {
  return {
    uri: "at://did:plc:test/app.smellgate.perfume/tile-test",
    cid: "bafytest",
    author_did: "did:plc:test",
    indexed_at: 0,
    name: "Boulot d'Hiver",
    house: "Test House",
    creator: null,
    release_year: null,
    description: null,
    external_refs_json: null,
    created_at: new Date(0).toISOString(),
    notes: [],
    ...overrides,
  };
}

describe("PerfumeTile highlight prop (#120)", () => {
  it("renders only the first 3 notes when no highlight is set (existing behavior)", () => {
    const perfume = makePerfume({
      notes: ["birch", "pine needle", "smoke", "tar", "vetiver"],
    });
    const html = renderToString(createElement(PerfumeTile, { perfume }));
    expect(html).toContain("birch");
    expect(html).toContain("pine needle");
    expect(html).toContain("smoke");
    // vetiver and tar are not in the first-3 slice.
    expect(html).not.toContain("vetiver");
    expect(html).not.toContain(">tar<");
  });

  it("pins the highlighted note first and includes two other notes", () => {
    const perfume = makePerfume({
      notes: ["birch", "pine needle", "smoke", "tar", "vetiver"],
    });
    const html = renderToString(
      createElement(PerfumeTile, { perfume, highlight: "vetiver" }),
    );
    // All three visible chips must be there, and vetiver must be
    // first in document order (so it visually reinforces the clicked
    // tag).
    expect(html).toContain("vetiver");
    const vetiverIdx = html.indexOf("vetiver");
    const birchIdx = html.indexOf("birch");
    const pineIdx = html.indexOf("pine needle");
    expect(vetiverIdx).toBeGreaterThan(-1);
    expect(birchIdx).toBeGreaterThan(-1);
    expect(pineIdx).toBeGreaterThan(-1);
    expect(vetiverIdx).toBeLessThan(birchIdx);
    expect(vetiverIdx).toBeLessThan(pineIdx);

    // Exactly 3 chips: the two notes after the highlight come from
    // the natural list order (`birch`, `pine needle`) — not `smoke`.
    expect(html).not.toContain("smoke");
    expect(html).not.toContain(">tar<");
  });

  it("shows all notes when the perfume has fewer than 3, with highlight first", () => {
    const perfume = makePerfume({ notes: ["vetiver", "moss"] });
    const html = renderToString(
      createElement(PerfumeTile, { perfume, highlight: "vetiver" }),
    );
    expect(html).toContain("vetiver");
    expect(html).toContain("moss");
    expect(html.indexOf("vetiver")).toBeLessThan(html.indexOf("moss"));
  });

  it("falls back to first-3 behavior when highlight is not in the notes list", () => {
    // Defensive path — shouldn't occur on a matched-tag page, but the
    // tile must not blow up if caller passes a note the perfume
    // doesn't have.
    const perfume = makePerfume({
      notes: ["birch", "pine needle", "smoke"],
    });
    const html = renderToString(
      createElement(PerfumeTile, { perfume, highlight: "vetiver" }),
    );
    expect(html).toContain("birch");
    expect(html).toContain("pine needle");
    expect(html).toContain("smoke");
    expect(html).not.toContain("vetiver");
  });

  it("applies a ring around the highlighted chip (#217 chroma change)", () => {
    const perfume = makePerfume({
      notes: ["birch", "vetiver", "smoke"],
    });
    const html = renderToString(
      createElement(PerfumeTile, { perfume, highlight: "vetiver" }),
    );
    // Since #217, chip background is the note's swatch colour, so
    // emphasis can't re-use `bg-zinc-200`. The highlighted chip gets
    // a ring instead. Per docs/ui.md we still avoid amber for tag
    // highlighting — amber is reserved for link semantics.
    expect(html).toMatch(
      /class="[^"]*ring-2[^"]*"[^>]*>vetiver<\/span>/,
    );
    // Non-highlighted chips have no ring.
    const birchChip = html.match(/<span[^>]*>birch<\/span>/)?.[0] ?? "";
    expect(birchChip).not.toMatch(/ring-2/);
  });
});
