/**
 * Location + shape of the state file written by `run-local.ts` and
 * consumed by `fixtures.ts`. Kept in its own module so fixtures don't
 * have to import the orchestrator (which pulls in `@atproto/dev-env`,
 * a Node-only ESM package that doesn't load cleanly under Playwright's
 * test runtime).
 */

import { tmpdir } from "node:os";
import { resolve } from "node:path";

export const LOCAL_STATE_PATH = resolve(
  tmpdir(),
  "smellgate-e2e-local-state.json",
);

export interface LocalState {
  pdsUrl: string;
  plcUrl: string;
  baseUrl: string;
  account: { did: string; handle: string; password: string };
}
