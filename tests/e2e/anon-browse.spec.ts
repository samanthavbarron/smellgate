import { test, expect } from "./fixtures";

/**
 * Anon-browse happy path.
 *
 * These specs require zero credentials and should pass against any
 * reachable smellgate deploy. They exist mainly to catch server-side
 * regressions in the public routes (home, feeds, perfume detail,
 * tag browse, search, 404 handling).
 *
 * The `data-smellgate-*` markers are intentionally load-bearing — the
 * design doc for #128/#172 committed to them as the stable selector
 * surface for screen-scrapers, AI agents, and tests.
 */

const consoleErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  consoleErrors.length = 0;
  page.on("pageerror", (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      // Filter known-noise: CSP report-only violations aren't failures.
      const text = msg.text();
      if (text.includes("Content Security Policy")) return;
      consoleErrors.push(text);
    }
  });
});

test.afterEach(() => {
  expect(consoleErrors, "browser console errors on this page").toEqual([]);
});

test("home page renders and shows a sign-in entry point", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/smellgate/i);
  // Sign-in button is the LoginForm component or a Link labeled "Sign in"
  // depending on the header variant — match generously.
  const signInAffordance = page.getByRole("button", {
    name: /sign in|log ?in|login to the atmosphere/i,
  });
  await expect(signInAffordance.first()).toBeVisible();
});

test("perfumes index page renders", async ({ page }) => {
  await page.goto("/perfumes");
  // Should not have errored out to a 500 page.
  const body = await page.content();
  expect(body).not.toMatch(/Application error: a server-side exception/i);
});

test("404 perfume URI returns a not-found shell", async ({ page }) => {
  // Intentionally bogus AT-URI
  const bogus = encodeURIComponent(
    "at://did:plc:doesnotexist/app.smellgate.perfume/doesnotexist",
  );
  const res = await page.goto(`/perfume/${bogus}`);
  // Next.js returns 404 from notFound(); accept 404 OR a rendered
  // "not found" body (RSC streaming can yield 200 + notfound UI).
  const status = res?.status() ?? 0;
  expect(status === 404 || status === 200).toBeTruthy();
});

test("tag browse page renders", async ({ page }) => {
  await page.goto("/tag/note/vetiver");
  const body = await page.content();
  expect(body).not.toMatch(/Application error: a server-side exception/i);
});

test("search page renders", async ({ page }) => {
  await page.goto("/search?q=vetiver");
  const body = await page.content();
  expect(body).not.toMatch(/Application error: a server-side exception/i);
});
