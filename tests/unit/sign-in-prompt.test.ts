/**
 * Unit tests for the shared `SignInPrompt` component and the 6
 * composer-surface sign-in links it backs (#178).
 *
 * Background: the composer pages used to embed a local `SignInPrompt`
 * that wrapped `/oauth/login?next=<path>` in a GET `<Link>` — but
 * `/oauth/login` is POST-only (accepts a handle, returns an authorize
 * URL), so every one of those links returned 405. The fix routes all
 * composer sign-in links to `/#sign-in`, the same anchor `SiteHeader`
 * and `app/profile/me/page.tsx` already use, which surfaces the
 * home-page `LoginForm` that does the actual POST.
 *
 * We verify two things:
 *
 * 1. The shared `SignInPrompt` renders a link pointing at `/#sign-in`.
 * 2. All 6 composer surfaces use the shared component (i.e. nobody
 *    regresses back to building a `/oauth/login?...` href locally).
 *    This is a grep-style source-level assertion rather than a
 *    runtime render: the composer pages are async server components
 *    with DB + session dependencies, and the regression we care about
 *    is "did someone inline a bad href again?", which a source check
 *    catches directly without spinning up the full Next runtime.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SignInPrompt } from "@/components/SignInPrompt";

const ROOT = path.resolve(__dirname, "..", "..");

const COMPOSER_SURFACES = [
  "app/submit/page.tsx",
  "app/perfume/[uri]/shelf/new/page.tsx",
  "app/perfume/[uri]/review/new/page.tsx",
  "app/perfume/[uri]/description/new/page.tsx",
  "app/review/[uri]/comment/new/page.tsx",
  "app/perfume/[uri]/page.tsx",
];

describe("SignInPrompt (#178)", () => {
  it("renders a Sign in link pointing at /#sign-in (matches SiteHeader)", () => {
    const html = renderToString(createElement(SignInPrompt));
    expect(html).toMatch(/href="\/#sign-in"/);
    expect(html).toContain(">Sign in<");
  });

  it("renders the default 'You need to sign in first.' copy", () => {
    const html = renderToString(createElement(SignInPrompt));
    expect(html).toContain("You need to sign in first.");
  });

  it("honors a custom message override", () => {
    const html = renderToString(
      createElement(SignInPrompt, { message: "Log in to vote." }),
    );
    expect(html).toContain("Log in to vote.");
    expect(html).toMatch(/href="\/#sign-in"/);
  });
});

describe("composer sign-in surfaces don't regress to /oauth/login (#178)", () => {
  for (const surface of COMPOSER_SURFACES) {
    it(`${surface} does not link to /oauth/login for anon users`, () => {
      const source = readFileSync(path.join(ROOT, surface), "utf8");
      // No `href` attribute pointing at /oauth/login anywhere in the
      // anon-user code path. (There are no logged-in /oauth/login
      // references in these files either — the live login flow is a
      // POST from the home-page form, not a link.)
      expect(source).not.toMatch(/href=[`"'][^`"']*\/oauth\/login/);
    });
  }

  // 5 of 6 surfaces use the shared component; the 6th
  // (app/perfume/[uri]/page.tsx) has an inline CTA with its own copy
  // ("Sign in to add, review, or describe") that links to /#sign-in
  // directly. Both patterns are acceptable.
  it("all 6 surfaces reference /#sign-in somewhere in the file", () => {
    for (const surface of COMPOSER_SURFACES) {
      const source = readFileSync(path.join(ROOT, surface), "utf8");
      const usesShared = source.includes(
        'from "@/components/SignInPrompt"',
      );
      const usesAnchor = source.includes("/#sign-in");
      expect(usesShared || usesAnchor, surface).toBe(true);
    }
  });
});
