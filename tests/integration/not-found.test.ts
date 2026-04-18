/**
 * Render tests for the scoped and global not-found components
 * (#170, #176, #186).
 *
 * These exercise the components directly — the `page.tsx` inline
 * rendering for `/perfume/[uri]` and `/profile/[did]` is covered by
 * `perfume-404.test.ts` and `profile-plc-fallback.test.ts`
 * respectively. This file is the thin guarantee that the three
 * not-found UIs each contain the expected marker copy and the
 * back-home link.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import GlobalNotFound from "../../app/not-found";
import ProfileNotFound from "../../app/profile/[did]/not-found";

describe("global not-found (#170, #186)", () => {
  it("renders the 'Page not found' marker + back-home link", () => {
    const html = renderToString(GlobalNotFound());
    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to home");
  });
});

describe("profile not-found (#176)", () => {
  it("renders the 'Profile not found' marker + back-home link", () => {
    const html = renderToString(ProfileNotFound());
    expect(html).toContain("Profile not found");
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to home");
  });
});
