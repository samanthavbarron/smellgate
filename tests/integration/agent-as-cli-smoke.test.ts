/**
 * Smoke test for the `agent-as` CLI entry point (#117 follow-up).
 *
 * Guards against the "exits 0 with no output" regression: the CLI
 * gates `main()` behind an `isEntryPoint()` check so tests can import
 * the module for its `__parsers` export without triggering OAuth, and
 * if the URL-equality check ever drifts (loader changes, trailing
 * slashes, symlinks) the CLI would become a silent no-op — `pnpm
 * agent:as …` exits 0 with nothing on stdout/stderr and no error
 * signal. Catching that requires actually spawning the script.
 *
 * We invoke with no args, which takes the shortest path through
 * `main()` → `usage()` → `process.exit(2)` and prints the usage banner
 * to stderr. If the entry-point gate ever stops firing, stderr will
 * be empty and exit code will be 0 — this test fails on both.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "agent-as.ts");

describe("agent-as CLI entry point smoke", () => {
  it("runs main() when executed directly (prints usage, exits non-zero)", () => {
    const result = spawnSync("pnpm", ["exec", "tsx", SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    // If main() didn't run, stderr would be empty and status would be
    // 0 — the silent no-op regression.
    expect(result.stderr).toContain("usage: pnpm agent:as");
    expect(result.status).toBe(2);
  }, 30_000);
});
