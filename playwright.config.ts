import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for smellgate's E2E suite (#216).
 *
 * Target URL resolution:
 *   - `SMELLGATE_E2E_URL` env var wins if set (useful when pointing a
 *     local `pnpm dev` instance at the test runner).
 *   - Otherwise we hit the live production deploy at
 *     `https://smellgate.app`. That is intentional: the tests are
 *     specifically designed to exercise real bsky.social OAuth, Fly
 *     networking, and Let's Encrypt certs — none of which are available
 *     against `http://localhost:3000`.
 *
 * Credentials for the OAuth login test are read from
 * `tests/e2e/helpers/creds.ts` — env vars first, then `tests/e2e/.secrets`
 * as a fallback for local runs. See `tests/e2e/README.md`.
 */
const baseURL = process.env.SMELLGATE_E2E_URL ?? "https://smellgate.app";

export default defineConfig({
  testDir: "./tests/e2e",
  // OAuth flow + cross-site redirects are slow; 60s per action is generous
  // but prevents a runaway hang from stalling CI forever.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // shared bsky account — serialize
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Real Chrome-ish UA so bsky.social's authorize page serves the HTML
    // form rather than a bot-flavored rejection.
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  outputDir: "test-results",
});
