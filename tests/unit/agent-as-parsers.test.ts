/**
 * Unit tests for `scripts/agent-as.ts`'s HTML parsers — the pure
 * functions in the `__parsers` export.
 *
 * The CLI used to count bare `data-smellgate-review` occurrences;
 * issue #117 upgraded it to extract URIs, ratings, and body snippets.
 * These tests cover the new extraction without going through a full
 * Next.js render (the integration test in
 * `tests/integration/render-agent-markers.test.ts` does that).
 */
import { describe, expect, it } from "vitest";
import { __parsers } from "@/scripts/agent-as";

describe("agent-as HTML parsers", () => {
  it("extractMarkedElements finds each tagged element with its URI + inner HTML", () => {
    const html = `
      <div>
        <article data-smellgate-review="at://did:plc:a/app.smellgate.review/aaa" class="card">
          <div>8/10</div>
          <p>First review body.</p>
        </article>
        <article data-smellgate-review="at://did:plc:a/app.smellgate.review/bbb">
          <div>3/10</div>
          <p>Second review body.</p>
        </article>
      </div>
    `;
    const hits = Array.from(
      __parsers.extractMarkedElements(html, "data-smellgate-review"),
    );
    expect(hits).toHaveLength(2);
    expect(hits[0].uri).toBe("at://did:plc:a/app.smellgate.review/aaa");
    expect(hits[0].inner).toContain("First review body");
    expect(hits[1].uri).toBe("at://did:plc:a/app.smellgate.review/bbb");
    expect(hits[1].inner).toContain("Second review body");
  });

  it("snippet strips tags and truncates", () => {
    const inner = "<p>Hello <strong>world</strong>.</p>";
    expect(__parsers.snippet(inner)).toBe("Hello world .");
    const long = "a".repeat(200);
    expect(__parsers.snippet(`<p>${long}</p>`, 50)).toMatch(/…$/);
  });

  it("extractRating finds N/10", () => {
    expect(__parsers.extractRating("<div>Rating: 7/10</div>")).toBe(7);
    expect(__parsers.extractRating("<div>no rating</div>")).toBeNull();
  });

  it("summarizePerfume returns URIs + rating + snippet for each review/description", () => {
    const html = `
      <main>
        <a href="/tag/note/amber">amber</a>
        <a href="/tag/note/oud">oud</a>
        <article data-smellgate-review="at://did/app.smellgate.review/r1">
          <div>8/10</div>
          <p>Reviewed body one.</p>
        </article>
        <article data-smellgate-description="at://did/app.smellgate.description/d1">
          <p>Description body one.</p>
        </article>
      </main>
    `;
    const out = __parsers.summarizePerfume(html);
    expect(out.notes.sort()).toEqual(["amber", "oud"]);
    expect(out.reviews).toEqual([
      {
        uri: "at://did/app.smellgate.review/r1",
        rating: 8,
        snippet: "8/10 Reviewed body one.",
      },
    ]);
    expect(out.descriptions).toEqual([
      {
        uri: "at://did/app.smellgate.description/d1",
        snippet: "Description body one.",
      },
    ]);
  });

  it("summarizeHome returns perfume URIs and review cards", () => {
    const html = `
      <main>
        <a href="/perfume/..." data-smellgate-perfume="at://did/app.smellgate.perfume/p1">
          <div>Name</div>
        </a>
        <a href="/perfume/..." data-smellgate-review="at://did/app.smellgate.review/r1">
          <div>5/10</div>
          <p>Home review.</p>
        </a>
      </main>
    `;
    const out = __parsers.summarizeHome(html);
    expect(out.perfumes).toEqual(["at://did/app.smellgate.perfume/p1"]);
    expect(out.reviews).toHaveLength(1);
    expect(out.reviews[0].uri).toBe("at://did/app.smellgate.review/r1");
    expect(out.reviews[0].rating).toBe(5);
    expect(out.reviews[0].snippet).toContain("Home review");
  });

  it("summarizeShelf pairs shelf-item URIs with their nested perfume URIs", () => {
    const html = `
      <ul>
        <li>
          <div data-smellgate-shelf-item="at://did/app.smellgate.shelfItem/s1">
            <a data-smellgate-perfume="at://did/app.smellgate.perfume/p1" href="/perfume/...">
              <div>Name</div>
            </a>
          </div>
        </li>
      </ul>
    `;
    const out = __parsers.summarizeShelf(html);
    expect(out.items).toEqual([
      {
        uri: "at://did/app.smellgate.shelfItem/s1",
        perfumeUri: "at://did/app.smellgate.perfume/p1",
      },
    ]);
  });

  it("summarizePerfume on HTML without markers returns empty arrays (not a crash)", () => {
    const out = __parsers.summarizePerfume("<main><p>no markers here</p></main>");
    expect(out.notes).toEqual([]);
    expect(out.reviews).toEqual([]);
    expect(out.descriptions).toEqual([]);
  });
});
