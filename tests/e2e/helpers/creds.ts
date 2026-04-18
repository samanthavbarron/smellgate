import fs from "node:fs";
import path from "node:path";

/**
 * Credential loader for E2E tests.
 *
 * Resolution order (first non-empty value wins):
 *   1. Process env (`BSKY_HANDLE`, `BSKY_PASSWORD`, or the
 *      `SMELLGATE_*` variants — see `lookup()` below).
 *   2. `tests/e2e/.secrets` in the repo (gitignored, KEY=VALUE format).
 *   3. `/tmp/.test-creds` on local dev boxes (matches the codespace
 *      convention already used by `scripts/agent-as.ts`).
 *
 * Returns `null` for any missing value so the caller can `test.skip()`
 * rather than failing noisily on a machine without creds configured.
 */

type CredMap = Record<string, string>;

function parseEnvFile(p: string): CredMap {
  if (!fs.existsSync(p)) return {};
  const out: CredMap = {};
  const text = fs.readFileSync(p, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

let _cache: CredMap | null = null;
function loadFileCreds(): CredMap {
  if (_cache) return _cache;
  const repoSecrets = path.resolve(__dirname, "..", ".secrets");
  // `/tmp/.test-creds` is a local-dev convenience (the codespace
  // convention, see scripts/agent-as.ts). On CI we MUST NOT read it:
  // GitHub Actions runners can have leftover files under /tmp from
  // previous job state, and picking up stale handle/password values
  // there would silently override the `production` environment
  // secrets we explicitly wired through env. GitHub Actions sets
  // `CI=true` on every runner.
  const tmpCreds = "/tmp/.test-creds";
  const fromTmp = process.env.CI ? {} : parseEnvFile(tmpCreds);
  _cache = { ...fromTmp, ...parseEnvFile(repoSecrets) };
  return _cache;
}

function lookup(keys: string[]): string | null {
  for (const k of keys) {
    if (process.env[k]) return process.env[k] as string;
  }
  const file = loadFileCreds();
  for (const k of keys) {
    if (file[k]) return file[k];
  }
  return null;
}

export interface OAuthCreds {
  /** bsky.social handle used to start the smellgate login. */
  handle: string;
  /** Account password bsky.social's OAuth form will accept. */
  password: string;
}

/**
 * Prefers the dedicated smellgate OAuth account vars
 * (`SMELLGATE_BSKY_HANDLE` / `SMELLGATE_BSKY_PASSWORD` / `E2E_BSKY_*`)
 * and only falls back to the app-password-shaped `BSKY_*` if those
 * are not set. The app-password form is NOT guaranteed to be accepted
 * by the OAuth `/oauth/authorize` HTML form — it is primarily an
 * XRPC credential.
 */
export function getOAuthCreds(): OAuthCreds | null {
  const handle = lookup([
    "SMELLGATE_BSKY_HANDLE",
    "E2E_BSKY_HANDLE",
    "BSKY_HANDLE",
    "BSKY_IDENTIFIER",
  ]);
  const password = lookup([
    "SMELLGATE_BSKY_PASSWORD",
    "E2E_BSKY_PASSWORD",
    "BSKY_PASSWORD",
    "BSKY_APP_PASSWORD",
  ]);
  if (!handle || !password) return null;
  return { handle, password };
}
