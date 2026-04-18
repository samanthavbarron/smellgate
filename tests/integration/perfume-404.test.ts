/**
 * Render test for the scoped `/perfume/[uri]` 404 page (issue #123).
 *
 * The bug: when the page calls `notFound()` on a missing URI, Next.js
 * fell back to an empty internal 404 which, in this app's layout,
 * stripped down to just the word "smellgate". The fix is a co-located
 * `app/perfume/[uri]/not-found.tsx` that Next.js auto-picks when
 * `notFound()` fires from the matching page.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import NotFound from "../../app/perfume/[uri]/not-found";

describe("perfume detail 404 (#123)", () => {
  it("renders the recognizable marker + back-home link", () => {
    const html = renderToString(NotFound());

    // The marker copy the bug report wanted. Without this, the page is
    // the empty "just the word smellgate" from issue #123.
    expect(html).toContain("Perfume not found");
    // A way out — the home link.
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to home");
  });
});
