// Next.js `instrumentation` hook — runs once per server process on boot,
// before any request is handled. We use it to apply pending Kysely
// migrations to the SQLite cache.
//
// In local dev the `pnpm dev` / `pnpm start` scripts run `pnpm migrate` via
// `tsx` before the server starts. In production under `next start` or the
// standalone `server.js`, there's no equivalent hook — `tsx` isn't in the
// runner image and `scripts/migrate.ts` isn't bundled into the standalone
// output. `register()` below is the Next-sanctioned equivalent.
//
// See: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation

// better-sqlite3 surfaces SQLite error codes on `err.code` as strings like
// "SQLITE_BUSY" or "SQLITE_CONSTRAINT_PRIMARYKEY". If two machines boot
// simultaneously against the same Fly volume, one can lose the race on a
// pending migration — the lock table, the UNIQUE PK on `kysely_migration`,
// or the WAL writer. In that case the peer is mid-migration and will
// finish; we should log and continue rather than crashing the machine into
// a restart loop with a cryptic error.
//
// In our current `min_machines_running = 1` shape this race is vanishingly
// rare, but it's a cheap guard to add now rather than after we debug a
// scale-up loop in prod.
const CONCURRENT_MIGRATION_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_LOCKED",
  "SQLITE_CONSTRAINT",
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_CONSTRAINT_UNIQUE",
]);

function isConcurrentMigrationError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && CONCURRENT_MIGRATION_CODES.has(code);
}

export async function register() {
  // `nodejs` runtime only. `instrumentation.ts` also fires under the edge
  // runtime, where better-sqlite3 isn't available.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Production-only: require TAP_ADMIN_PASSWORD to be a non-empty string.
  //
  // The webhook route's legacy `if (TAP_ADMIN_PASSWORD)` check treats an
  // empty string as "auth disabled", which would make `/api/webhook`
  // publicly unauthenticated. An unset secret OR `flyctl secrets set
  // TAP_ADMIN_PASSWORD=""` would both silently open this hole. Hard-fail
  // on boot instead so the mis-config is caught at deploy time, not
  // after events start flowing through a public endpoint.
  //
  // Gated on NODE_ENV=production so local dev (no Tap, no webhook) and
  // the integration tests (which stub the env explicitly) both stay
  // unaffected. The route handler also has a defence-in-depth runtime
  // check that rejects requests if this somehow gets bypassed.
  if (process.env.NODE_ENV === "production") {
    const pw = process.env.TAP_ADMIN_PASSWORD;
    if (typeof pw !== "string" || pw.length === 0) {
      const msg =
        "[instrumentation] TAP_ADMIN_PASSWORD must be set to a non-empty string in production. " +
        "Set it via `flyctl secrets set --app smellgate TAP_ADMIN_PASSWORD=<value>` " +
        "matching the value on the smellgate-tap app (docs/deployment.md).";
      console.error(msg);
      throw new Error(msg);
    }
  }

  const { getMigrator } = await import("./lib/db/migrations");
  const migrator = getMigrator();
  // Kysely's migrateToLatest() documents that it never throws — it returns
  // `{ error, results }`. Defensive try/catch is still here because the
  // underlying better-sqlite3 driver can surface errors in surprising
  // layers (e.g. lock-table creation) that pre-date Kysely's wrapping.
  try {
    const { error } = await migrator.migrateToLatest();
    if (error) {
      if (isConcurrentMigrationError(error)) {
        console.warn(
          "[instrumentation] Migration lost race to a peer machine; continuing:",
          error,
        );
        return;
      }
      console.error("[instrumentation] Migration failed:", error);
      throw error;
    }
  } catch (err) {
    if (isConcurrentMigrationError(err)) {
      console.warn(
        "[instrumentation] Migration threw on a concurrency error; continuing:",
        err,
      );
      return;
    }
    throw err;
  }
  console.log("[instrumentation] Migrations complete.");
}
