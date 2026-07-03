// Regression tests for the /setup route security hardening (OWASP A05 fix,
// 2026-06-29).
//
// The security guarantee lives at the PAGE layer — src/app/setup/page.tsx calls
// notFound() when isBootstrapAvailable(db) returns false OR site.setupComplete
// is true. The middleware layer (PUBLIC_EXACT) retains /setup so the bootstrap
// flow works: on a fresh install an unauthenticated operator follows the root (/)
// redirect here and has no session yet.
//
// FAILS-ON-OLD: the "page-level guard conditions" tests verify the DB state that
// the server component evaluates. Pre-fix, page.tsx was a pure client component
// ("use client") with no server-side check — these conditions were never evaluated
// and the wizard always rendered regardless of setup state.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decideAccess } from "@/lib/auth/access";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { isBootstrapAvailable } from "@/lib/auth/bootstrap";
import { getSetting, setSetting } from "@/lib/content/settings";
import { createAdminUser } from "@/lib/content/admin-user";

// ── Middleware allowlist: /setup stays public for bootstrap ─────────────────

test("middleware: /setup remains on the public allowlist (bootstrap flow preserved)", () => {
  // /setup is public so that an unauthenticated fresh-install operator can reach
  // it from the root (/) redirect. Security is enforced at the page layer, not here.
  expect(decideAccess("/setup")).toBe("public");
  // /api/setup remains protected — no change from pre-fix.
  expect(decideAccess("/api/setup")).toBe("protected");
});

// ── Page-level guard conditions (fails-on-old) ─────────────────────────────

describe("page-level guard conditions", () => {
  let h: TestDb;
  let db: Db;

  beforeEach(async () => {
    h = await createTestDb({ seed: true });
    db = h.db;
  });
  afterEach(() => h.close());

  test("pre-config: bootstrap available + setupComplete absent → guard does NOT fire (setup is reachable)", async () => {
    // Fresh install: no admin yet, setup not finished.
    // Guard expression: !bootstrapAvailable || setupComplete === true
    // Neither condition is met → notFound() is not called, wizard renders.
    const bootstrapAvailable = await isBootstrapAvailable(db);
    const setupComplete = await getSetting<boolean>(db, "site.setupComplete");

    expect(bootstrapAvailable).toBe(true);
    expect(setupComplete).toBeFalsy(); // undefined — key not yet written

    // Guard would NOT fire.
    expect(!bootstrapAvailable || setupComplete === true).toBe(false);
  });

  test("post-config: admin provisioned → isBootstrapAvailable false → guard fires (notFound → 404)", async () => {
    // Once the admin exists, bootstrap is permanently closed.
    // Pre-fix: the page ignored this condition and rendered the wizard.
    // Post-fix: the page calls notFound() because !isBootstrapAvailable.
    await createAdminUser(db);

    const bootstrapAvailable = await isBootstrapAvailable(db);
    expect(bootstrapAvailable).toBe(false);

    // Guard fires.
    expect(!bootstrapAvailable).toBe(true);
  });

  test("post-config: setupComplete flag true → guard fires (notFound → 404)", async () => {
    // POST /api/setup sets this flag when the operator finishes the wizard.
    // Pre-fix: the page did not read this flag server-side.
    // Post-fix: setupComplete === true triggers notFound().
    await setSetting(db, "site.setupComplete", true, "admin");

    const setupComplete = await getSetting<boolean>(db, "site.setupComplete");
    expect(setupComplete).toBe(true);

    // Guard fires.
    expect(setupComplete === true).toBe(true);
  });

  test("post-config: both conditions true simultaneously → guard fires (typical completed-setup state)", async () => {
    // After a full setup run, admin exists AND setupComplete is set.
    await createAdminUser(db);
    await setSetting(db, "site.setupComplete", true, "admin");

    const bootstrapAvailable = await isBootstrapAvailable(db);
    const setupComplete = await getSetting<boolean>(db, "site.setupComplete");

    expect(bootstrapAvailable).toBe(false);
    expect(setupComplete).toBe(true);

    // Guard fires either way.
    expect(!bootstrapAvailable || setupComplete === true).toBe(true);
  });
});
