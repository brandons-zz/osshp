// Next.js instrumentation hook — auto-runs database migrations on server boot.
//
// Called once by Next.js before the first request is served (in both `next dev`
// and the standalone `bun server.js` artifact). Running only on the "nodejs"
// runtime guards against accidental execution in the Edge runtime or browser
// bundles. initializeDatabase() is idempotent: migrate() is a no-op when the
// schema is already current, so re-booting an already-migrated deployment is
// safe.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail loud at boot on a weak SESSION_SECRET (A02-G1) or a weak-but-present
    // OSSHP_ENCRYPTION_KEY (security-review NB-1): a forgeable-cookie instance,
    // or one that would SHA-256-derive a weak AES-256-GCM key for TOTP secrets
    // at rest, must never start. This runs before any request is served.
    const { assertSessionSecretStrength, assertEncryptionKeyStrength } =
      await import("./lib/auth/secret-strength");
    assertSessionSecretStrength(process.env.SESSION_SECRET);
    assertEncryptionKeyStrength(process.env.OSSHP_ENCRYPTION_KEY);

    // Retry while the database is merely unreachable (e.g. Postgres still
    // starting after a host/daemon restart, when the restart policy brings app
    // and db up together and depends_on is not honored). Next.js caches a
    // rejected register() for the life of the process — one transient failure
    // here would otherwise 500 every request until a manual restart. Real
    // failures (a bad migration, wrong credentials) are not retried.
    const { initializeDatabase, getDb } = await import("./lib/db/client");
    const { retryTransient, StartupRetryExhaustedError } = await import(
      "./lib/db/startup-retry"
    );
    try {
      await retryTransient(() => initializeDatabase(), {
        // Only this reachability check is time-bounded; migrations, once the
        // database answers, may take as long as they need.
        probe: () => getDb().query("select 1"),
        onRetry: ({ attempt, delayMs, error }) => {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(
            `[osshp] database not ready (attempt ${attempt}: ${reason}); retrying in ${delayMs}ms`,
          );
        },
      });
    } catch (err) {
      if (err instanceof StartupRetryExhaustedError) {
        // Still unreachable after the deadline. Exit rather than stay up
        // serving 500s: the container restart policy (restart: unless-stopped)
        // then starts a fresh process, which retries again.
        console.error(`[osshp] ${err.message} — exiting so the container restarts`);
        process.exit(1);
      }
      throw err;
    }
  }
}
