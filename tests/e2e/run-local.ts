/**
 * Orchestrator for `E2E_MODE=local` Playwright runs (issue #221).
 *
 * Boots the full local smellgate test stack:
 *   1. Starts an in-process `TestNetworkNoAppView` (ephemeral PDS + PLC)
 *      via `@atproto/dev-env` — same helper the integration tests use.
 *   2. Pre-creates a test account on the PDS and stashes its credentials
 *      in a temp state file that the Playwright fixture reads.
 *   3. Spawns `next dev` on a free port with `SMELLGATE_DEV_HANDLE_RESOLVER`
 *      / `SMELLGATE_DEV_PLC_URL` pointing at the in-process network, and
 *      `PUBLIC_URL` unset so `lib/auth/client.ts` picks the loopback
 *      OAuth client metadata (no keyset / no HTTPS required).
 *   4. Waits for `GET /api/health` on the dev server before running
 *      Playwright.
 *   5. Runs Playwright (any extra CLI args are forwarded).
 *   6. Cleans up: kills dev, closes PDS, deletes state file.
 *
 * Why a script and not Playwright's `webServer` config: starting the PDS
 * has to happen FIRST so we can set env vars on the `next dev` child.
 * Playwright's `webServer.env` is a static object evaluated at config
 * load; there's no clean way to inject a port we only learn after the
 * PDS boots. Doing the orchestration in one explicit script also keeps
 * teardown reliable — the finally block runs on any exit path (pass,
 * fail, SIGINT).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { TestNetworkNoAppView } from "@atproto/dev-env";

import { LOCAL_STATE_PATH, type LocalState } from "./local-state";

const HEALTH_TIMEOUT_MS = 90_000;
/**
 * The OAuth loopback client metadata built in `lib/auth/client.ts` —
 * when `PUBLIC_URL` is unset — hardcodes `redirect_uris:
 * ["http://127.0.0.1:3000/oauth/callback"]`, so the dev server MUST
 * listen on 3000 for the callback to reach it. If the port is busy
 * on a developer machine, kill the other process; we don't try to
 * auto-pick a free port.
 */
const DEV_PORT = 3000;
const TEST_ACCOUNT = {
  shortName: "e2e",
  handle: "e2e-test.test",
  email: "e2e@test.invalid",
  password: "e2e-password",
};

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status === 200) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `timed out waiting for ${url} within ${timeoutMs}ms: ${String(lastErr)}`,
  );
}

async function main(): Promise<number> {
  // ---- 1. Start PDS ----
  console.log("[e2e-local] starting ephemeral PDS + PLC...");
  const network = await TestNetworkNoAppView.create({});
  const pdsUrl: string = network.pds.url;
  const plcUrl: string = (network as unknown as { plc: { url: string } }).plc
    .url;
  console.log(`[e2e-local] pds ${pdsUrl}  plc ${plcUrl}`);

  let devProc: ChildProcess | null = null;
  let shuttingDown = false;

  const cleanup = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[e2e-local] tearing down...");
    if (devProc && devProc.pid != null && devProc.exitCode === null) {
      try {
        process.kill(-devProc.pid, "SIGTERM");
      } catch {
        try {
          devProc.kill("SIGTERM");
        } catch {
          /* best effort */
        }
      }
      // Give it a moment to exit gracefully before hard-killing.
      await new Promise((r) => setTimeout(r, 500));
      try {
        if (devProc.exitCode === null) process.kill(-devProc.pid, "SIGKILL");
      } catch {
        /* best effort */
      }
    }
    try {
      await network.close();
    } catch (err) {
      console.warn("[e2e-local] PDS close error:", err);
    }
    try {
      if (existsSync(LOCAL_STATE_PATH)) rmSync(LOCAL_STATE_PATH);
    } catch {
      /* best effort */
    }
  };

  process.on("SIGINT", () => {
    void cleanup().then(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    void cleanup().then(() => process.exit(143));
  });

  try {
    // ---- 2. Pre-create the test account ----
    console.log(
      `[e2e-local] creating account ${TEST_ACCOUNT.handle}...`,
    );
    const seedClient = network.getSeedClient();
    const acct = await seedClient.createAccount(TEST_ACCOUNT.shortName, {
      handle: TEST_ACCOUNT.handle,
      email: TEST_ACCOUNT.email,
      password: TEST_ACCOUNT.password,
    });
    console.log(`[e2e-local] account ${acct.handle} → ${acct.did}`);

    // ---- 3. Spawn `next dev` with dev-network env vars ----
    const baseUrl = `http://127.0.0.1:${DEV_PORT}`;
    const dbDir = resolve(tmpdir(), `smellgate-e2e-local-${process.pid}`);
    mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, "cache.db");
    console.log(`[e2e-local] starting next dev on ${baseUrl} (db=${dbPath})`);
    devProc = spawn(
      "pnpm",
      [
        "exec",
        "next",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(DEV_PORT),
      ],
      {
        cwd: resolve(dirname(new URL(import.meta.url).pathname), "..", ".."),
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
        env: {
          ...process.env,
          // Don't inherit any production-shaped values from the current
          // shell — scrub anything that might sidetrack the loopback
          // OAuth client selection in `lib/auth/client.ts`.
          PUBLIC_URL: "",
          PRIVATE_KEY: "",
          TAP_URL: "",
          TAP_ADMIN_PASSWORD: "",
          SMELLGATE_CURATOR_DIDS: acct.did,
          // The gate in lib/auth/client.ts + lib/db/queries.ts.
          SMELLGATE_DEV_HANDLE_RESOLVER: pdsUrl,
          SMELLGATE_DEV_PLC_URL: plcUrl,
          DATABASE_PATH: dbPath,
          NODE_ENV: "development",
        },
      },
    );
    devProc.on("exit", (code, signal) => {
      if (!shuttingDown) {
        console.warn(
          `[e2e-local] next dev exited unexpectedly (code=${code} signal=${signal})`,
        );
      }
    });

    // ---- 4. Wait for /api/health ----
    console.log("[e2e-local] waiting for dev server...");
    await waitForHealth(`${baseUrl}/api/health`, HEALTH_TIMEOUT_MS);
    console.log("[e2e-local] dev server up");

    // ---- 5. Write state file for the Playwright fixtures ----
    const state: LocalState = {
      pdsUrl,
      plcUrl,
      baseUrl,
      account: {
        did: acct.did,
        handle: acct.handle,
        password: TEST_ACCOUNT.password,
      },
    };
    writeFileSync(LOCAL_STATE_PATH, JSON.stringify(state, null, 2));

    // ---- 6. Run Playwright ----
    const pwArgs = process.argv.slice(2);
    console.log(
      `[e2e-local] running playwright test ${pwArgs.join(" ")} ...`,
    );
    const pwExit = await new Promise<number>((resolveP) => {
      const pw = spawn(
        "pnpm",
        ["exec", "playwright", "test", ...pwArgs],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            E2E_MODE: "local",
            SMELLGATE_E2E_URL: baseUrl,
          },
        },
      );
      pw.on("exit", (code) => resolveP(code ?? 1));
    });
    return pwExit;
  } finally {
    await cleanup();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[e2e-local] fatal:", err);
    process.exit(1);
  });
