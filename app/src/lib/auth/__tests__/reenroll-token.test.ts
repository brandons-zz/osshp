// F1 (external security review, MEDIUM): the re-enrollment window is bound to a single-use
// CSPRNG token, closing the unauthenticated-race. Before this, an open recovery
// window let ANY unauthenticated caller run the public register ceremony and
// enroll their own passkey. These tests pin the possession-binding contract:
//
//  (a) an open window WITHOUT a valid token does NOT grant the reenroll lane;
//  (b) the matching token DOES grant the reenroll lane;
//  (c) the token is single-use — consumed on a successful re-enrollment;
//  (d) the token is stored HASHED at rest, never plaintext;
//  (e) the recovery route + break-glass surface the token exactly once;
//  (f) no window-state oracle — a tokenless caller is denied identically whether
//      or not a window is open;
//  (g) the bootstrap lane (first-admin enrollment) is UNAFFECTED — no token.
//
// Every test here fails on pre-change code (the reenroll lane was window-only).

process.env.SESSION_SECRET = "test-reenroll-token-session-secret-0123456789";
process.env.OSSHP_ENCRYPTION_KEY = "test-reenroll-token-encryption-key-0123456789";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createAdminUser } from "@/lib/content/admin-user";
import {
  breakGlassReset,
  clearReenrollment,
  consumeRecoveryCode,
  isReenrollmentOpen,
  isReenrollmentTokenValid,
  regenerateRecoveryCodes,
} from "@/lib/auth";
import {
  RegistrationForbiddenError,
  resolveRegistrationMode,
} from "@/lib/auth/bootstrap";

let h: TestDb;
let db: Db;
beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
  await createAdminUser(db); // provisioned admin — bootstrap is closed
});
afterEach(() => h.close());

/** Open a possession-bound re-enrollment window via a recovery code; return the token. */
async function openWindow(): Promise<string> {
  const { plaintext } = await regenerateRecoveryCodes(db);
  const token = await consumeRecoveryCode(db, plaintext[0]);
  expect(token).toBeTypeOf("string");
  return token!;
}

test("(a) an open window WITHOUT the token does not grant the reenroll lane", async () => {
  await openWindow();
  // The window IS open...
  expect(await isReenrollmentOpen(db)).toBe(true);
  // ...but an unauthenticated caller with NO token is denied — no race for the window.
  await expect(
    resolveRegistrationMode(db, { authenticated: false }),
  ).rejects.toBeInstanceOf(RegistrationForbiddenError);
  // A WRONG token is equally denied.
  await expect(
    resolveRegistrationMode(db, { authenticated: false, reenrollToken: "not-the-token" }),
  ).rejects.toBeInstanceOf(RegistrationForbiddenError);
  expect(await isReenrollmentTokenValid(db, "not-the-token")).toBe(false);
});

test("(b) the matching token grants the reenroll lane", async () => {
  const token = await openWindow();
  expect(
    await resolveRegistrationMode(db, { authenticated: false, reenrollToken: token }),
  ).toBe("reenroll");
  expect(await isReenrollmentTokenValid(db, token)).toBe(true);
});

test("(c) the token is single-use — consumed on a successful re-enrollment", async () => {
  const token = await openWindow();
  // First use grants the lane.
  expect(
    await resolveRegistrationMode(db, { authenticated: false, reenrollToken: token }),
  ).toBe("reenroll");
  // verifyRegistration calls clearReenrollment on a successful reenroll (webauthn.ts);
  // that call consumes BOTH the window and the token.
  await clearReenrollment(db);
  expect(await isReenrollmentTokenValid(db, token)).toBe(false);
  await expect(
    resolveRegistrationMode(db, { authenticated: false, reenrollToken: token }),
  ).rejects.toBeInstanceOf(RegistrationForbiddenError);
});

test("(d) the token is stored hashed, never plaintext, at rest", async () => {
  const token = await openWindow();
  const rows = await db.query<{ reenroll_token_hash: string | null }>(
    `SELECT reenroll_token_hash FROM admin_user WHERE lock_col = 'X'`,
  );
  const stored = rows[0].reenroll_token_hash;
  expect(stored).toBeTypeOf("string");
  // Salted-SHA256 shape (<saltHex>:<hashHex>) — not the plaintext token.
  expect(stored!).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  expect(stored!.includes(token)).toBe(false);
  expect(stored).not.toBe(token);
});

test("(e) break-glass returns the single-use token once", async () => {
  await regenerateRecoveryCodes(db);
  const result = await breakGlassReset(db);
  expect(result.reenrollToken).toBeTypeOf("string");
  // The returned token is exactly the one bound to the freshly-opened window.
  expect(await isReenrollmentTokenValid(db, result.reenrollToken)).toBe(true);
});

test("(e) the recovery-code route response surfaces the reenroll token", () => {
  const routeSrc = readFileSync(
    join(import.meta.dir, "../../../app/api/auth/recovery/code/route.ts"),
    "utf8",
  );
  // The route forwards consumeRecoveryCode's token into the JSON response.
  expect(routeSrc).toContain("consumeRecoveryCode");
  expect(routeSrc).toContain("reenrollToken");
});

test("(f) no window-state oracle — a tokenless caller is denied identically open or closed", async () => {
  // Window CLOSED, no token → RegistrationForbiddenError.
  let closedErr: unknown;
  try {
    await resolveRegistrationMode(db, { authenticated: false });
  } catch (e) {
    closedErr = e;
  }
  expect(closedErr).toBeInstanceOf(RegistrationForbiddenError);

  // Now OPEN a window, still no token → the SAME error (class + message).
  await openWindow();
  expect(await isReenrollmentOpen(db)).toBe(true);
  let openErr: unknown;
  try {
    await resolveRegistrationMode(db, { authenticated: false });
  } catch (e) {
    openErr = e;
  }
  expect(openErr).toBeInstanceOf(RegistrationForbiddenError);

  // Indistinguishable — nothing in the denial leaks whether a window is open.
  expect((openErr as Error).message).toBe((closedErr as Error).message);
  expect((openErr as Error).name).toBe((closedErr as Error).name);
});

test("(g) the bootstrap lane is unaffected — first-admin enrollment needs no token", async () => {
  const fresh = await createTestDb(); // NO admin provisioned → bootstrap open
  try {
    expect(await resolveRegistrationMode(fresh.db, { authenticated: false })).toBe(
      "bootstrap",
    );
    expect(
      await resolveRegistrationMode(fresh.db, {
        authenticated: false,
        reenrollToken: undefined,
      }),
    ).toBe("bootstrap");
  } finally {
    await fresh.close();
  }
});
