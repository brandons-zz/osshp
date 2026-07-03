// Single-use setup-wizard bootstrap gate (auth-security-assessment §9 NO-GO #1, #2).
//
// The first passkey is enrolled through the bootstrap path, which is available
// ONLY while no admin exists. The instant the admin row is created (M1.3
// createAdminUser, guarded by the admin_user lock_col UNIQUE), bootstrap is
// permanently closed — a re-run of the wizard can no longer provision an admin.
// After bootstrap, every further enrollment requires an authenticated admin
// session (step-up). This module is the single source of that decision.

import type { Db } from "@/lib/db/types";
import { getAdminUser } from "@/lib/content/admin-user";
import { isReenrollmentTokenValid } from "./reenroll";

/** True only while no admin has been provisioned (bootstrap window open). */
export async function isBootstrapAvailable(db: Db): Promise<boolean> {
  return (await getAdminUser(db)) === null;
}

export type RegistrationMode = "bootstrap" | "step-up" | "reenroll";

/** Thrown when registration is attempted but neither lane is permitted. */
export class RegistrationForbiddenError extends Error {
  constructor() {
    super(
      "Passkey registration requires an authenticated admin session (the " +
        "single-use setup wizard is closed once the admin exists).",
    );
    this.name = "RegistrationForbiddenError";
  }
}

/**
 * Decide which registration lane applies, fail-closed:
 *  - no admin yet              → "bootstrap" (the single-use wizard window)
 *  - admin exists + authed     → "step-up"   (add another passkey)
 *  - admin exists + reenroll   → "reenroll"  (a recovery event opened a window —
 *                                 re-establish a passkey, R6; no session held)
 *  - admin exists + none above → throws RegistrationForbiddenError
 *
 * This keeps the wizard un-re-runnable (NO-GO #1) and post-bootstrap registration
 * gated (NO-GO #2): the only unauthenticated post-bootstrap lane is "reenroll",
 * and it opens ONLY after a proof-of-possession recovery event (a valid single-use
 * recovery code or local-exec break-glass) — AND requires the single-use token
 * that event minted (F1). The token makes the window possession-bound: an
 * unauthenticated caller without it is denied whether or not a window is open, so
 * there is no window-state oracle and no unauthenticated race for an open window.
 *
 * The `reenrollToken` gate is scoped to the reenroll lane ONLY — the bootstrap
 * lane (first-admin enrollment, no admin yet) is unaffected and still needs no
 * token.
 */
export async function resolveRegistrationMode(
  db: Db,
  ctx: { authenticated: boolean; reenrollToken?: string },
): Promise<RegistrationMode> {
  if (await isBootstrapAvailable(db)) return "bootstrap";
  if (ctx.authenticated) return "step-up";
  if (await isReenrollmentTokenValid(db, ctx.reenrollToken)) return "reenroll";
  throw new RegistrationForbiddenError();
}
