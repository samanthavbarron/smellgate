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

export async function register() {
  // `nodejs` runtime only. `instrumentation.ts` also fires under the edge
  // runtime, where better-sqlite3 isn't available.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getMigrator } = await import("./lib/db/migrations");
  const migrator = getMigrator();
  const { error } = await migrator.migrateToLatest();
  if (error) {
    // Crash loud — the machine can't serve if the schema is out of date.
    console.error("[instrumentation] Migration failed:", error);
    throw error;
  }
  console.log("[instrumentation] Migrations complete.");
}
