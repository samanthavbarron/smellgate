import fs from "node:fs";
import { test as base, expect } from "@playwright/test";
import { getOAuthCreds } from "./helpers/creds";
import { LOCAL_STATE_PATH, type LocalState } from "./local-state";

/**
 * Test fixtures for the smellgate E2E suite.
 *
 * Two supported run modes (`E2E_MODE`):
 *   - `live` (default): target URL is `https://smellgate.app` (or
 *     whatever `SMELLGATE_E2E_URL` is set to). OAuth credentials come
 *     from env / `tests/e2e/.secrets` / `/tmp/.test-creds`. The login
 *     flow hits the real bsky.social authorize page.
 *   - `local`: a fresh ephemeral PDS + PLC (`@atproto/dev-env`) and a
 *     `next dev` pointed at it are booted by
 *     `tsx tests/e2e/run-local.ts`, which writes the PDS URL and
 *     pre-created account to a temp state file. This fixture reads
 *     that file. Invoke with `pnpm test:e2e:local`; never run
 *     `pnpm test:e2e` directly in local mode.
 *
 * Tests should read `fixtures.creds` for login creds (nullable — the
 * fixture calls `test.skip()` in live mode when they aren't present,
 * so anon-browse specs keep running on credless machines). In local
 * mode `creds` is always populated.
 *
 * `authorizeOrigin` is the origin the OAuth authorize page lives on —
 * `https://bsky.social` in live mode, the local PDS URL in local
 * mode. Specs that wait for a navigation into that page use this.
 */

export type E2EMode = "live" | "local";

export function getMode(): E2EMode {
  const raw = process.env.E2E_MODE?.toLowerCase();
  if (raw === "local") return "local";
  return "live";
}

function loadLocalState(): LocalState {
  if (!fs.existsSync(LOCAL_STATE_PATH)) {
    throw new Error(
      `E2E_MODE=local but ${LOCAL_STATE_PATH} is missing. Run the suite via \`pnpm test:e2e:local\` so the orchestrator can start the PDS + dev server first.`,
    );
  }
  return JSON.parse(fs.readFileSync(LOCAL_STATE_PATH, "utf8")) as LocalState;
}

export interface SmellgateFixtures {
  mode: E2EMode;
  /** Resolved base URL, mirrors `use.baseURL` in `playwright.config.ts`. */
  baseUrl: string;
  /**
   * Origin of the OAuth authorize page. `https://bsky.social` in live
   * mode; the ephemeral PDS URL in local mode.
   */
  authorizeOrigin: string;
  /** OAuth credentials or `null` when none are configured. */
  creds: { handle: string; password: string } | null;
  /**
   * Provisions a fresh bsky account for the current test. In `live`
   * mode this just returns the long-lived shared account (we can't
   * conjure accounts on bsky.social). In `local` mode this returns
   * the ephemeral account `run-local.ts` pre-created — one per
   * `run-local` invocation, not per-test, since the orchestrator
   * holds the PDS handle in a different process.
   */
  createAccount(): Promise<{ handle: string; password: string }>;
}

export const test = base.extend<SmellgateFixtures>({
  mode: async ({}, use) => {
    await use(getMode());
  },
  baseUrl: async ({ mode }, use) => {
    if (mode === "local") {
      await use(loadLocalState().baseUrl);
    } else {
      await use(process.env.SMELLGATE_E2E_URL ?? "https://smellgate.app");
    }
  },
  authorizeOrigin: async ({ mode }, use) => {
    if (mode === "local") {
      await use(new URL(loadLocalState().pdsUrl).origin);
    } else {
      await use("https://bsky.social");
    }
  },
  creds: async ({ mode }, use) => {
    if (mode === "local") {
      const { handle, password } = loadLocalState().account;
      await use({ handle, password });
    } else {
      await use(getOAuthCreds());
    }
  },
  createAccount: async ({ creds, mode }, use) => {
    await use(async () => {
      if (!creds) {
        if (mode === "local") {
          throw new Error(
            "E2E_MODE=local but the state file has no account — did run-local.ts finish its pre-create step?",
          );
        }
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
