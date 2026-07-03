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

    const { initializeDatabase } = await import("./lib/db/client");
    await initializeDatabase();
  }
}
