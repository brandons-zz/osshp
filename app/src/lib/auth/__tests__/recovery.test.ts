// Layered recovery lanes — integration (PGlite). Proves the load-bearing
// invariants: password+TOTP requires BOTH (password alone never authenticates),
// secrets are non-plaintext at rest, one-time-per-step, recovery codes are
// single-use and revoke ALL sessions, break-glass resets + opens re-enrollment,
// and the re-enrollment registration lane is gated.

process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-prod-recovery";
process.env.OSSHP_ENCRYPTION_KEY =
  "test-encryption-key-do-not-use-in-prod-recovery-0123456789";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createAdminUser, getAdminUser } from "@/lib/content/admin-user";
import {
  breakGlassReset,
  confirmTotp,
  consumeRecoveryCode,
  currentTotpToken,
  enrollTotp,
  isBoxed,
  isReenrollmentOpen,
  regenerateRecoveryCodes,
  setPassword,
  verifyPasswordAndTotp,
} from "@/lib/auth";
import {
  resolveRegistrationMode,
  RegistrationForbiddenError,
} from "@/lib/auth/bootstrap";
import { clearReenrollment } from "@/lib/auth/reenroll";
import { createSession, validateSession } from "@/lib/auth/sessions";
import { setAuditSink, type AuthAuditRecord } from "@/lib/auth/audit";

const PW = "a-strong-admin-password-123";
const PERIOD = 30;
const EPOCH = 1_700_000_000;

let h: TestDb;
let db: Db;
beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
  await createAdminUser(db); // provision the single admin (no credentials yet)
});
afterEach(() => h.close());

/** Enroll password + a confirmed TOTP; return the TOTP secret. */
async function enrollBothFactors(confirmEpoch = EPOCH - PERIOD): Promise<string> {
  await setPassword(db, PW);
  const { secret } = await enrollTotp(db);
  const token = await currentTotpToken(secret, { epoch: confirmEpoch });
  expect(await confirmTotp(db, token, { epoch: confirmEpoch })).toBe(true);
  return secret;
}

test("password+TOTP requires BOTH factors — password ALONE never authenticates", async () => {
  const secret = await enrollBothFactors();
  const goodToken = await currentTotpToken(secret, { epoch: EPOCH });

  // password right + totp right → authenticates
  expect(await verifyPasswordAndTotp(db, PW, goodToken, { epoch: EPOCH })).toBe(true);

  // password right + totp WRONG → rejected (password alone is not enough)
  expect(await verifyPasswordAndTotp(db, PW, "000000", { epoch: EPOCH + PERIOD })).toBe(false);
  // password WRONG + totp right → rejected
  const tok2 = await currentTotpToken(secret, { epoch: EPOCH + 2 * PERIOD });
  expect(await verifyPasswordAndTotp(db, "wrong-password", tok2, { epoch: EPOCH + 2 * PERIOD })).toBe(false);
});

test("the fallback lane never authenticates when TOTP is not enrolled+enabled", async () => {
  await setPassword(db, PW); // password only, no TOTP
  expect(await verifyPasswordAndTotp(db, PW, "123456", { epoch: EPOCH })).toBe(false);
});

test("one-time-per-step: a code cannot be reused within its step (T2)", async () => {
  const secret = await enrollBothFactors();
  const stepEpoch = EPOCH + 10 * PERIOD;
  const token = await currentTotpToken(secret, { epoch: stepEpoch });
  // First use authenticates and consumes the step.
  expect(await verifyPasswordAndTotp(db, PW, token, { epoch: stepEpoch })).toBe(true);
  // Same token, same step → rejected (replay).
  expect(await verifyPasswordAndTotp(db, PW, token, { epoch: stepEpoch })).toBe(false);
  // Next step → accepted again.
  const next = await currentTotpToken(secret, { epoch: stepEpoch + PERIOD });
  expect(await verifyPasswordAndTotp(db, PW, next, { epoch: stepEpoch + PERIOD })).toBe(true);
});

test("TOTP secret and recovery codes are NON-plaintext at rest (T1/R2/NO-GO #6)", async () => {
  const secret = await enrollBothFactors();
  const { plaintext } = await regenerateRecoveryCodes(db);

  // Read the raw stored columns directly — not via the domain mapper.
  const rows = await db.query<{ totp_secret: string; recovery_codes: string[] }>(
    `SELECT totp_secret, recovery_codes FROM admin_user WHERE lock_col = 'X'`,
  );
  const stored = rows[0];
  // TOTP secret: stored encrypted (boxed), not the plaintext base32 secret.
  expect(isBoxed(stored.totp_secret)).toBe(true);
  expect(stored.totp_secret.includes(secret)).toBe(false);
  // Recovery codes: stored hashed, none equal a plaintext code.
  for (const code of plaintext) {
    for (const storedHash of stored.recovery_codes) {
      expect(storedHash.includes(code.replace(/-/g, ""))).toBe(false);
    }
  }
});

test("a recovery code is single-use and revokes ALL sessions + opens re-enrollment", async () => {
  const { plaintext } = await regenerateRecoveryCodes(db);
  const a = await createSession(db);
  const b = await createSession(db);
  expect(await validateSession(db, a.token)).not.toBeNull();

  // consumeRecoveryCode now returns the single-use re-enrollment token (F1).
  expect(await consumeRecoveryCode(db, plaintext[0])).toBeTypeOf("string");
  // S4 — every session gone.
  expect(await validateSession(db, a.token)).toBeNull();
  expect(await validateSession(db, b.token)).toBeNull();
  // R6 — re-enrollment window open, no session granted by the lane itself.
  expect(await isReenrollmentOpen(db)).toBe(true);
  // Single-use — the same code cannot be used again (returns null).
  expect(await consumeRecoveryCode(db, plaintext[0])).toBeNull();
});

test("consumeRecoveryCode captures the request's client IP on the session.revoke_all audit event", async () => {
  // Security Center IP-surfacing follow-up: the recovery-code route always has a
  // request in hand, so it must be threaded through to the audit write.
  const { plaintext } = await regenerateRecoveryCodes(db);

  const lines: string[] = [];
  const restore = setAuditSink((r: AuthAuditRecord) => lines.push(JSON.stringify(r)));
  let token: string | null;
  try {
    const request = new Request("https://x/", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    token = await consumeRecoveryCode(db, plaintext[0], request);
  } finally {
    setAuditSink(restore);
  }
  expect(token).toBeTypeOf("string");

  const records = lines.map((l) => JSON.parse(l) as AuthAuditRecord);
  const revokeAll = records.find((r) => r.event === "session.revoke_all");
  expect(revokeAll).toBeDefined();
  expect(revokeAll!.ip).toBe("203.0.113.7");
});

test("consumeRecoveryCode with no request in scope leaves the audit ip null (unchanged back-compat)", async () => {
  const { plaintext } = await regenerateRecoveryCodes(db);

  const lines: string[] = [];
  const restore = setAuditSink((r: AuthAuditRecord) => lines.push(JSON.stringify(r)));
  try {
    await consumeRecoveryCode(db, plaintext[0]);
  } finally {
    setAuditSink(restore);
  }

  const records = lines.map((l) => JSON.parse(l) as AuthAuditRecord);
  const revokeAll = records.find((r) => r.event === "session.revoke_all");
  expect(revokeAll).toBeDefined();
  expect(revokeAll!.ip).toBeNull();
});

test("break-glass revokes all sessions, mints fresh codes, opens re-enrollment, audits (no secret)", async () => {
  await regenerateRecoveryCodes(db);
  const s = await createSession(db);

  const lines: string[] = [];
  const restore = setAuditSink((r: AuthAuditRecord) => lines.push(JSON.stringify(r)));
  let result;
  try {
    result = await breakGlassReset(db);
  } finally {
    setAuditSink(restore);
  }

  expect(result.recoveryCodes.length).toBe(10);
  expect(await validateSession(db, s.token)).toBeNull(); // S4
  expect(await isReenrollmentOpen(db)).toBe(true);

  // Audit: break_glass + session.revoke_all emitted; no recovery code value leaked.
  const records = lines.map((l) => JSON.parse(l) as AuthAuditRecord);
  const events = records.map((r) => r.event);
  expect(events).toContain("break_glass");
  expect(events).toContain("session.revoke_all");
  for (const line of lines) {
    for (const code of result.recoveryCodes) {
      expect(line.includes(code)).toBe(false);
    }
  }
  // breakGlassReset is CLI-only (NO-GO #5) — there is no HTTP request anywhere
  // on this path to attribute an IP to, so both events legitimately carry
  // ip: null (see the function's doc comment; the Security Center UI renders
  // this as an explicit "IP not recorded" state, not a blank).
  expect(records.find((r) => r.event === "session.revoke_all")!.ip).toBeNull();
  expect(records.find((r) => r.event === "break_glass")!.ip).toBeNull();
});

test("re-enrollment registration lane is gated: open only after a recovery event + with its token (F1)", async () => {
  // Fresh admin, unauthenticated, no recovery event → registration forbidden.
  await expect(resolveRegistrationMode(db, { authenticated: false })).rejects.toBeInstanceOf(
    RegistrationForbiddenError,
  );

  // Authenticated step-up is always allowed.
  expect(await resolveRegistrationMode(db, { authenticated: true })).toBe("step-up");

  // A recovery event opens the window AND mints the single-use token; only the
  // token-bearing unauthenticated caller gets the "reenroll" lane (F1).
  const { plaintext } = await regenerateRecoveryCodes(db);
  const token = await consumeRecoveryCode(db, plaintext[0]);
  expect(token).toBeTypeOf("string");
  expect(
    await resolveRegistrationMode(db, { authenticated: false, reenrollToken: token! }),
  ).toBe("reenroll");

  // Closing the window (a successful re-enrollment would) re-locks the lane even
  // for the token-bearer.
  await clearReenrollment(db);
  await expect(
    resolveRegistrationMode(db, { authenticated: false, reenrollToken: token! }),
  ).rejects.toBeInstanceOf(RegistrationForbiddenError);
});

test("a fresh admin (no recovery) still cannot self-confirm TOTP without enrolling", async () => {
  // confirmTotp with no pending secret returns false (verify-before-enable guard).
  expect(await confirmTotp(db, "123456", { epoch: EPOCH })).toBe(false);
  const admin = await getAdminUser(db);
  expect(admin?.totpEnabled).toBe(false);
});
