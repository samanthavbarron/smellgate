import { test as base, expect } from "@playwright/test";
import { getOAuthCreds } from "./helpers/creds";

/**
 * Test fixtures for the smellgate E2E suite.
 *
 * Two supported run modes (`E2E_MODE`):
 *   - `live` (default): target URL is `https://smellgate.app` (or
 *     whatever `SMELLGATE_E2E_URL` is set to). OAuth credentials come
 *     from env / `tests/e2e/.secrets` / `/tmp/.test-creds`. The login
 *     flow hits the real bsky.social authorize page.
 *   - `local` (TODO, see `docs/e2e.md` follow-up): spin up an ephemeral
 *     PDS via `@atproto/dev-env`, point a local `pnpm dev` at it with
 *     `SMELLGATE_DEV_HANDLE_RESOLVER` / `SMELLGATE_DEV_PLC_URL`, and
 *     `createAccount()` provisions fresh handles per test. Not wired
 *     yet — tracked in the follow-up to #216.
 *
 * Tests should read `fixtures.creds` for login creds (nullable — the
 * fixture calls `test.skip()` in live mode when they aren't present,
 * so anon-browse specs keep running on credless machines).
 */

export type E2EMode = "live" | "local";

export function getMode(): E2EMode {
  const raw = process.env.E2E_MODE?.toLowerCase();
  if (raw === "local") return "local";
  return "live";
}

export interface SmellgateFixtures {
  mode: E2EMode;
  /** Resolved base URL, mirrors `use.baseURL` in `playwright.config.ts`. */
  baseUrl: string;
  /** OAuth credentials or `null` when none are configured. */
  creds: { handle: string; password: string } | null;
  /**
   * Provisions a fresh bsky account for the current test. In `live`
   * mode this just returns the long-lived shared account (we can't
   * conjure accounts on bsky.social), in `local` mode (TODO) it will
   * mint one against the ephemeral PDS.
   */
  createAccount(): Promise<{ handle: string; password: string }>;
}

export const test = base.extend<SmellgateFixtures>({
  mode: async ({}, use) => {
    await use(getMode());
  },
  baseUrl: async ({}, use) => {
    await use(process.env.SMELLGATE_E2E_URL ?? "https://smellgate.app");
  },
  creds: async ({}, use) => {
    await use(getOAuthCreds());
  },
  createAccount: async ({ creds, mode }, use) => {
    await use(async () => {
      if (mode === "local") {
        throw new Error(
          "E2E_MODE=local is not yet wired. See tests/e2e/README.md.",
        );
      }
      if (!creds) {
        throw new Error(
          "No bsky OAuth creds available. Set SMELLGATE_BSKY_HANDLE/PASSWORD " +
            "or E2E_BSKY_HANDLE/PASSWORD, or add them to tests/e2e/.secrets.",
        );
      }
      return creds;
    });
  },
});

export { expect };
