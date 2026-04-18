import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";
import type { Page, Request, Response } from "@playwright/test";

/**
 * End-to-end OAuth login against bsky.social.
 *
 * This test is the #216 headliner AND the repro harness for the
 * 2026-04-18 production hang: after the bsky "Login complete, you are
 * being redirected..." screen, the browser never navigates back to
 * smellgate's `/oauth/callback` endpoint.
 *
 * Because the redirect is done entirely inside the bsky-side HTML (a
 * meta-refresh or JS `location.assign` — we can't tell from outside),
 * the only way to catch the failure is to listen to Page events and
 * dump the entire network trace the moment we either succeed or time
 * out on the callback.
 *
 * Artifacts land under `tests/e2e/artifacts/<test-title>/` so the
 * orchestrator can inspect them after a run.
 */

interface NetworkLogEntry {
  kind: "request" | "response" | "failed" | "console" | "pageerror";
  t: number; // ms since epoch
  method?: string;
  url?: string;
  status?: number;
  headers?: Record<string, string>;
  location?: string | null;
  text?: string;
}

function installNetworkLog(page: Page): NetworkLogEntry[] {
  const log: NetworkLogEntry[] = [];
  const t0 = Date.now();
  const push = (e: Omit<NetworkLogEntry, "t">) =>
    log.push({ ...e, t: Date.now() - t0 });
  page.on("request", (req: Request) => {
    push({
      kind: "request",
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
    });
  });
  page.on("response", (res: Response) => {
    const loc = res.headers()["location"] ?? null;
    push({
      kind: "response",
      method: res.request().method(),
      url: res.url(),
      status: res.status(),
      location: loc,
      headers: res.headers(),
    });
  });
  page.on("requestfailed", (req) => {
    push({
      kind: "failed",
      method: req.method(),
      url: req.url(),
      text: req.failure()?.errorText ?? "unknown",
    });
  });
  page.on("console", (msg) => {
    push({ kind: "console", text: `[${msg.type()}] ${msg.text()}` });
  });
  page.on("pageerror", (err) => {
    push({ kind: "pageerror", text: err.message });
  });
  return log;
}

async function dumpArtifacts(
  page: Page,
  testName: string,
  log: NetworkLogEntry[],
  reason: string,
) {
  const slug = testName.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 80);
  const dir = path.resolve(__dirname, "artifacts", slug);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await page.screenshot({
      path: path.join(dir, "screenshot.png"),
      fullPage: true,
    });
  } catch {
    // Page may be closed if we hit a nav failure.
  }
  try {
    const html = await page.content();
    fs.writeFileSync(path.join(dir, "page.html"), html);
  } catch {
    /* noop */
  }
  try {
    const url = page.url();
    fs.writeFileSync(path.join(dir, "final-url.txt"), url);
  } catch {
    /* noop */
  }
  fs.writeFileSync(
    path.join(dir, "network.json"),
    JSON.stringify({ reason, entries: log }, null, 2),
  );
}

test.describe("OAuth login", () => {
  test("signs in and lands back on smellgate authenticated", async ({
    page,
    creds,
    baseUrl,
    authorizeOrigin,
  }, testInfo) => {
    test.skip(
      !creds,
      "No OAuth creds configured. Set SMELLGATE_BSKY_HANDLE/PASSWORD or E2E_BSKY_*, or run via `pnpm test:e2e:local`.",
    );
    const log = installNetworkLog(page);

    try {
      // 1. Load smellgate home.
      await page.goto("/");

      // 2. Open the LoginForm. Some layouts have the form always visible;
      //    others surface it behind a "Sign in" button. Try the button,
      //    fall back to assuming the form is already on the page.
      const maybeSignInBtn = page.getByRole("button", {
        name: /^sign in$/i,
      });
      if (await maybeSignInBtn.first().isVisible().catch(() => false)) {
        await maybeSignInBtn.first().click();
      }

      const handleInput = page.getByPlaceholder(/bsky\.social/i).first();
      await handleInput.fill(creds!.handle);

      // 3. Submit the form — the LoginForm POSTs /oauth/login then does a
      //    full-page `window.location.href = redirectUrl`. The authorize
      //    page lives on `bsky.social` in live mode and on the ephemeral
      //    PDS in local mode.
      const authorizeRe = new RegExp(
        `^${authorizeOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/oauth/authorize`,
      );
      await Promise.all([
        page.waitForURL(authorizeRe, {
          timeout: 30_000,
        }),
        page
          .getByRole("button", { name: /login to the atmosphere/i })
          .click(),
      ]);

      // 4. We are now on bsky.social's authorize page. Fill the
      //    credential form. The DOM is bsky's, not ours — match
      //    generously on input[name]. bsky pre-fills the username
      //    field (readonly + disabled) because the handle travels
      //    through PAR, so we only need to fill the password.
      const userInput = page
        .locator('input[name="username"], input[name="identifier"]')
        .first();
      if (
        (await userInput.count()) > 0 &&
        (await userInput.isEditable().catch(() => false))
      ) {
        await userInput.fill(creds!.handle);
      }
      const passInput = page
        .locator('input[name="password"], input[type="password"]')
        .first();
      await passInput.fill(creds!.password);

      // 5. Submit the bsky login form.
      await page
        .locator('button[type="submit"]')
        .first()
        .click();

      // The OAuth provider shows a consent/approve screen after login.
      // Against bsky.social the button has the standard `role="button"`
      // and Playwright's `getByRole` matches fine. Against the
      // `@atproto/oauth-provider` used by both bsky and the dev-env PDS,
      // the authorize button is `<button role="Button" type="submit">` —
      // capitalized `Button` is not a standard aria role, so
      // `getByRole("button", ...)` misses it. Fall back to a text-based
      // locator on any `<button>` element, and wait up to 10s for the
      // SPA to transition from the sign-in panel to the consent panel.
      const approve = page
        .locator("button")
        .filter({ hasText: /^(accept|approve|allow|authorize|continue)$/i });
      try {
        await approve.first().waitFor({ state: "visible", timeout: 10_000 });
        await approve.first().click();
      } catch {
        // If the provider skipped consent (remembered previous grant,
        // e.g.) that's fine — fall through to the URL wait below.
      }

      // 6. The critical wait: bsky should meta-refresh / redirect us to
      //    `${baseUrl}/oauth/callback?code=...&state=...`, and our
      //    callback handler should 302 us to `${baseUrl}/`. Give the
      //    whole chain 45s.
      await page.waitForURL(
        (url) =>
          url.origin === new URL(baseUrl).origin &&
          (url.pathname === "/" ||
            url.pathname.startsWith("/profile") ||
            url.pathname === "/oauth/callback"),
        { timeout: 45_000 },
      );

      // 7. Confirm we ended up on smellgate with a session cookie.
      const cookies = await page.context().cookies();
      const didCookie = cookies.find((c) => c.name === "did");
      expect(
        didCookie,
        "smellgate should have set a `did` session cookie",
      ).toBeTruthy();
    } catch (err) {
      await dumpArtifacts(
        page,
        testInfo.title,
        log,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  });
});
