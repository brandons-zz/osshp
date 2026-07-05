// Layered recovery lanes — orchestration (auth-security-assessment §5–§7, §9).
//
// The single-identity model has no peer-admin recovery, so this layered chain IS
// the compensating control and is held to the same bar as the primary passkey
// auth. This module composes the primitives (password / totp / secret-box /
// recovery-codes / sessions / reenroll / audit) into the actual lanes:
//
//   1. Password+TOTP fallback login  — BOTH factors; password alone NEVER
//      authenticates (NO-GO #3). One-time-per-step replay guard on the TOTP code.
//   2. Recovery code                 — single-use; on use revokes ALL sessions
//      (S4) and opens a re-enrollment window (R6: re-enrollment, NOT standing
//      access). Issues no session by itself.
//   3. Credential enrollment/change  — set password, enroll+confirm TOTP
//      (verify-before-enable, secret encrypted at rest), (re)generate recovery
//      codes (display-once). The route layer revokes other sessions on change.
//   4. CLI break-glass               — local-exec reset: revoke all sessions,
//      mint fresh recovery codes, open a re-enrollment window, audit-logged.
//
// Node-only (pulls node:crypto via secret-box / recovery-codes) — never imported
// by the Edge middleware.

import type { Db } from "@/lib/db/types";
import { getAdminUser, updateAdminUser } from "@/lib/content/admin-user";
import { hashPassword, verifyPassword } from "./password";
import {
  generateTotpSecret,
  totpProvisioningUri,
  verifyTotp,
} from "./totp";
import { decryptSecret, encryptSecret } from "./secret-box";
import {
  generateRecoveryCodes,
  verifyAndConsumeRecoveryCode,
  type GeneratedRecoveryCodes,
} from "./recovery-codes";
import { revokeAllSessions } from "./sessions";
import { grantReenrollment } from "./reenroll";
import { recordAuthEvent } from "./audit";

// ── Lane 3a: password enrollment / change ─────────────────────────────────────

/** Set (or change) the admin password — argon2id hashed at rest. */
export async function setPassword(db: Db, plaintext: string): Promise<void> {
  const hash = await hashPassword(plaintext);
  await updateAdminUser(db, { passwordHash: hash });
}

// ── Lane 3b: TOTP enrollment (verify-before-enable) ───────────────────────────

export interface TotpEnrollment {
  /** The base32 secret — DISPLAY ONCE (QR/manual entry); never shown again. */
  secret: string;
  /** otpauth:// URI for an authenticator app. */
  uri: string;
}

/**
 * Begin TOTP enrollment: mint a secret, store it ENCRYPTED at rest with
 * totp_enabled=false, and return the plaintext secret + provisioning URI for
 * one-time display. The lane does not count until confirmTotp() verifies a code
 * (verify-before-enable, T5).
 */
export async function enrollTotp(
  db: Db,
  opts: { issuer?: string; label?: string } = {},
): Promise<TotpEnrollment> {
  const secret = generateTotpSecret();
  await updateAdminUser(db, {
    totpSecret: encryptSecret(secret),
    totpEnabled: false,
    totpLastStep: 0,
  });
  return {
    secret,
    uri: totpProvisioningUri(secret, {
      issuer: opts.issuer ?? "osshp",
      label: opts.label ?? "admin",
    }),
  };
}

/**
 * Confirm a pending TOTP enrollment with a valid code (verify-before-enable, T5).
 * On success enables the lane and records the consumed step. Returns false if no
 * pending secret or the code is invalid.
 */
export async function confirmTotp(
  db: Db,
  token: string,
  opts: { epoch?: number } = {},
): Promise<boolean> {
  const admin = await getAdminUser(db);
  if (!admin?.totpSecret) return false;
  const secret = decryptSecret(admin.totpSecret);
  const result = await verifyTotp(secret, token, opts);
  if (!result.valid || result.step === null) return false;
  await updateAdminUser(db, {
    totpEnabled: true,
    totpLastStep: result.step,
  });
  return true;
}

// ── Lane 1: password + TOTP fallback login ────────────────────────────────────

/**
 * Verify the password+TOTP fallback lane. Returns true ONLY when BOTH the
 * password AND a current TOTP code verify (NO-GO #3 — password alone never
 * authenticates), TOTP is enrolled+enabled, and the code's step has not already
 * been consumed (one-time-per-step, T2). On success the consumed step is
 * persisted. This lane grants a login (the caller rotates a session); it is NOT a
 * credential-change event.
 */
export async function verifyPasswordAndTotp(
  db: Db,
  password: string,
  totpToken: string,
  opts: { epoch?: number } = {},
): Promise<boolean> {
  const admin = await getAdminUser(db);
  // Both factors must be provisioned; an un-enrolled lane never authenticates.
  if (!admin?.passwordHash || !admin.totpEnabled || !admin.totpSecret) {
    return false;
  }
  const passwordOk = await verifyPassword(password, admin.passwordHash);
  // Always evaluate the TOTP too (do not short-circuit) so a single missing
  // factor is indistinguishable from both wrong, and password-alone can never
  // pass: even a correct password returns false unless the TOTP also verifies.
  const totp = await verifyTotp(decryptSecret(admin.totpSecret), totpToken, opts);
  const stepFresh = totp.step !== null && totp.step > admin.totpLastStep;
  if (!passwordOk || !totp.valid || !stepFresh) return false;
  await updateAdminUser(db, { totpLastStep: totp.step! });
  return true;
}

// ── Lane 3c: recovery-code (re)generation ─────────────────────────────────────

/**
 * Generate a fresh set of recovery codes, store them HASHED (replacing any prior
 * set — regeneration invalidates the old set, R4), and return the plaintext for
 * ONE-TIME display (R4). Plaintext is never persisted.
 */
export async function regenerateRecoveryCodes(
  db: Db,
): Promise<GeneratedRecoveryCodes> {
  const generated = generateRecoveryCodes();
  await updateAdminUser(db, { recoveryCodes: generated.hashed });
  return generated;
}

// ── Lane 2: recovery-code use ─────────────────────────────────────────────────

/**
 * Consume a recovery code. On a match: remove it (single-use, R3), REVOKE ALL
 * sessions (S4), and open a possession-bound re-enrollment window (R6 —
 * re-enrollment, not standing access; this issues NO session). Emits
 * session.revoke_all where revokeAllSessions is called. Returns the single-use
 * re-enrollment token (surfaced ONCE by the route so the operator's client can
 * complete the register ceremony — F1) on a match, or null if no code matched.
 */
export async function consumeRecoveryCode(
  db: Db,
  code: string,
): Promise<string | null> {
  const admin = await getAdminUser(db);
  if (!admin) return null;
  const { matched, remaining } = verifyAndConsumeRecoveryCode(
    code,
    admin.recoveryCodes,
  );
  if (!matched) return null;
  await updateAdminUser(db, { recoveryCodes: remaining });
  await revokeAllSessions(db);
  recordAuthEvent("session.revoke_all", "success", {
    details: { reason: "recovery_code" },
  });
  return grantReenrollment(db);
}

// ── Lane 4: CLI break-glass reset ─────────────────────────────────────────────

export interface BreakGlassResult {
  /** Fresh recovery codes — printed ONCE by the CLI, then discarded. */
  recoveryCodes: string[];
  /** Single-use re-enrollment token — printed ONCE by the CLI (F1). The operator
   *  presents it to the register ceremony to re-establish a passkey; without it
   *  the open window is not unauthenticated-enrollable. */
  reenrollToken: string;
}

/**
 * Local-exec break-glass reset (B1–B4 / NO-GO #5). Revokes ALL sessions (S4),
 * mints a fresh recovery-code set (the old set is invalidated), and opens a
 * re-enrollment window so the operator can re-establish a passkey after, e.g., a
 * domain change bricked the old one. Audit-logged. This function is called ONLY by
 * the CLI script — there is deliberately NO HTTP route that invokes it (NO-GO #5).
 * The caller (CLI) prints the returned codes; no secret is taken as an argument.
 */
export async function breakGlassReset(db: Db): Promise<BreakGlassResult> {
  const admin = await getAdminUser(db);
  if (!admin) {
    throw new Error(
      "No admin to reset — run the first-run setup wizard to provision the admin.",
    );
  }
  await revokeAllSessions(db);
  const generated = generateRecoveryCodes();
  await updateAdminUser(db, { recoveryCodes: generated.hashed });
  const reenrollToken = await grantReenrollment(db, { ttlMs: 1000 * 60 * 30 }); // 30-min window
  recordAuthEvent("session.revoke_all", "success", {
    details: { reason: "break_glass" },
  });
  recordAuthEvent("break_glass", "success", {
    details: { action: "admin_reset" },
  });
  return { recoveryCodes: generated.plaintext, reenrollToken };
}
