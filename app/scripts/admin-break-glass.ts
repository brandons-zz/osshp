#!/usr/bin/env bun
// CLI break-glass admin reset (auth-security-assessment §7 / B1–B4 / NO-GO #5).
//
// LOCAL EXEC ONLY. There is deliberately NO HTTP route that triggers this — the
// justified threat model is "the operator owns the container" (`docker exec`), at
// which point auth is already moot, so exposing a network reset would only ADD an
// attacker capability (NO-GO #5). Run it inside the running container:
//
//   docker compose exec app ./admin-break-glass
//   (or: `bun run admin:break-glass`)
//
// It takes NO secret as a command-line argument (B2 — secrets in argv leak via
// process listings / shell history): the fresh recovery codes are generated
// SERVER-SIDE by breakGlassReset and printed here exactly once. The reset revokes
// all sessions (S4), invalidates the old recovery-code set, opens a short
// re-enrollment window so the operator can register a fresh passkey (e.g. after a
// domain change bricked the old one), and is audit-logged.

import { getDb, initializeDatabase } from "@/lib/db/client";
import { breakGlassReset } from "@/lib/auth";

async function main(): Promise<void> {
  const db = getDb();
  await initializeDatabase(db);
  const { recoveryCodes, reenrollToken } = await breakGlassReset(db);

  process.stdout.write(
    "\nosshp break-glass reset complete.\n" +
      "  • All sessions revoked.\n" +
      "  • A re-enrollment window is open — register a new passkey now via the\n" +
      "    login screen's recovery flow, using the re-enrollment token below.\n" +
      "  • Re-enrollment token (single-use, shown ONCE — the window cannot be\n" +
      "    used to enroll a passkey without it):\n\n",
  );
  process.stdout.write(`    ${reenrollToken}\n\n`);
  process.stdout.write(
    "  • The previous recovery-code set is invalidated. New recovery codes\n" +
      "    (store these somewhere safe — shown ONCE):\n\n",
  );
  for (const code of recoveryCodes) {
    process.stdout.write(`    ${code}\n`);
  }
  process.stdout.write("\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(
      `break-glass failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
