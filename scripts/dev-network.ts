/**
 * scripts/dev-network.ts — long-running local ATProto network for the
 * multi-agent bug-bash setup (issue #106).
 *
 * Spins up an in-process `TestNetworkNoAppView` (PDS + PLC, no AppView)
 * via `@atproto/dev-env`, provisions a known set of test accounts, writes
 * URLs + credentials + DIDs to `.smellgate-dev-env.json`, and then sleeps
 * forever until killed with Ctrl+C / SIGTERM.
 *
 * This is the same `dev-env` machinery the integration tests use via
 * `tests/helpers/pds.ts`, but in long-running mode and going through
 * `dev-env` directly so we can read the PLC URL (which the test helper
 * intentionally hides). The dev-network script is a privileged developer
 * tool — touching `dev-env` directly is fine here. Tests must continue
 * to use the narrow helper.
 *
 * Once running:
 *
 *   - `cat .smellgate-dev-env.json` shows the URLs, DIDs, and passwords
 *   - Start the dev server in another shell with the printed env vars
 *     so `lib/auth/client.ts` resolves handles + DIDs against this
 *     network instead of the real `plc.directory`
 *   - `pnpm agent:as alice whoami` drives the OAuth flow against the
 *     dev server, which in turn talks to this network
 *
 * Killing this process discards all state (it's all in-memory). The
 * agent CLI's stored sessions in `.smellgate-agent-sessions/` will then
 * be stale — delete that directory and re-login.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TestNetworkNoAppView } from "@atproto/dev-env";

const DEV_ENV_FILE = resolve(process.cwd(), ".smellgate-dev-env.json");

type AccountSpec = { shortName: string; handle: string; password: string };

const REGULAR_USERS: AccountSpec[] = [
  { shortName: "alice", handle: "alice.test", password: "password-alice" },
  { shortName: "bob", handle: "bob.test", password: "password-bob" },
  { shortName: "carol", handle: "carol.test", password: "password-carol" },
  { shortName: "dan", handle: "dan.test", password: "password-dan" },
];

const CURATOR_USER: AccountSpec = {
  shortName: "curator",
  handle: "curator.test",
  password: "password-curator",
};

type DevEnvFile = {
  pdsUrl: string;
  plcUrl: string;
  curator: { handle: string; did: string; password: string };
  accounts: { handle: string; did: string; password: string }[];
};

async function main(): Promise<void> {
  console.log("[dev-network] starting in-process PDS + PLC...");
  const network = await TestNetworkNoAppView.create({});
  const pdsUrl: string = network.pds.url;
  // dev-env exposes the PLC server on the network instance; the type
  // isn't re-exported from the package barrel, so we read structurally.
  const plcUrl: string = (network as unknown as { plc: { url: string } }).plc
    .url;

  console.log(`[dev-network] pds:  ${pdsUrl}`);
  console.log(`[dev-network] plc:  ${plcUrl}`);
  console.log("[dev-network] provisioning test accounts...");

  const seedClient = network.getSeedClient();
  type Created = AccountSpec & { did: string };
  const created: Created[] = [];
  for (const spec of [CURATOR_USER, ...REGULAR_USERS]) {
    const acct = await seedClient.createAccount(spec.shortName, {
      handle: spec.handle,
      email: `${spec.shortName}@test.invalid`,
      password: spec.password,
    });
    created.push({ ...spec, did: acct.did });
  }

  const curator = created.find((a) => a.shortName === "curator")!;
  const regulars = created.filter((a) => a.shortName !== "curator");

  const file: DevEnvFile = {
    pdsUrl,
    plcUrl,
    curator: {
      handle: curator.handle,
      did: curator.did,
      password: curator.password,
    },
    accounts: regulars.map((a) => ({
      handle: a.handle,
      did: a.did,
      password: a.password,
    })),
  };

  mkdirSync(dirname(DEV_ENV_FILE), { recursive: true });
  writeFileSync(DEV_ENV_FILE, JSON.stringify(file, null, 2) + "\n");
  console.log(`[dev-network] wrote ${DEV_ENV_FILE}`);
  console.log("[dev-network] accounts:");
  for (const a of created) {
    console.log(`  ${a.handle.padEnd(16)} ${a.did}`);
  }
  console.log("");
  console.log("[dev-network] To start the dev server against this network:");
  console.log("");
  console.log(`  SMELLGATE_DEV_HANDLE_RESOLVER=${pdsUrl} \\`);
  console.log(`  SMELLGATE_DEV_PLC_URL=${plcUrl} \\`);
  console.log(`  SMELLGATE_CURATOR_DIDS=${curator.did} \\`);
  console.log(`  pnpm dev`);
  console.log("");
  console.log("[dev-network] ready. Press Ctrl+C to stop.");

  let closing = false;
  const stop = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log("\n[dev-network] shutting down...");
    try {
      await network.close();
    } catch (err) {
      console.warn("[dev-network] close error:", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[dev-network] fatal:", err);
  process.exit(1);
});
