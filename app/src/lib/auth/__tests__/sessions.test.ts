// Session store: signature integrity, revocability, rotation, expiry, cookie attrs.

process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-prod";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import {
  clearedSessionCookieHeader,
  createSession,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  sessionCookieHeader,
  SESSION_COOKIE_NAME,
  signToken,
  sweepExpiredSessions,
  validateSession,
  verifyTokenSignature,
} from "../sessions";

let h: TestDb;
let db: Db;
beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("session id is high-entropy (>=128-bit) and round-trips through validation", async () => {
  const session = await createSession(db);
  const id = await verifyTokenSignature(session.token);
  expect(id).not.toBeNull();
  // 256-bit id => 64 hex chars (well above the 128-bit/32-hex floor, S1).
  expect(id!.length).toBe(64);
  const record = await validateSession(db, session.token);
  expect(record).not.toBeNull();
  expect(record!.id).toBe(id);
});

test("a tampered signature is rejected (HMAC integrity, S1)", async () => {
  const session = await createSession(db);
  const [idPart] = session.token.split(".");
  const forged = `${idPart}.${"0".repeat(64)}`;
  expect(await verifyTokenSignature(forged)).toBeNull();
  // Even though the id row exists, an invalid signature must not validate.
  expect(await validateSession(db, forged)).toBeNull();
});

test("a validly-signed id with no DB row does not validate (revocable, S4)", async () => {
  // Sign an id that was never inserted — signature is valid but there is no row.
  const token = await signToken("a".repeat(64));
  expect(await verifyTokenSignature(token)).not.toBeNull();
  expect(await validateSession(db, token)).toBeNull();
});

test("revokeSession invalidates a live session", async () => {
  const session = await createSession(db);
  expect(await validateSession(db, session.token)).not.toBeNull();
  await revokeSession(db, session.token);
  expect(await validateSession(db, session.token)).toBeNull();
});

test("revokeAllSessions clears every session (recovery invariant S4)", async () => {
  const a = await createSession(db);
  const b = await createSession(db);
  await revokeAllSessions(db);
  expect(await validateSession(db, a.token)).toBeNull();
  expect(await validateSession(db, b.token)).toBeNull();
});

test("rotateSession issues a new id and kills the old one (fixation defense S3)", async () => {
  const old = await createSession(db);
  const fresh = await rotateSession(db, old.token);
  expect(fresh.token).not.toBe(old.token);
  expect(await validateSession(db, old.token)).toBeNull();
  expect(await validateSession(db, fresh.token)).not.toBeNull();
});

test("an expired session does not validate (S5)", async () => {
  const expired = await createSession(db, { ttlMs: -1000 });
  expect(await validateSession(db, expired.token)).toBeNull();
});

test("an idle session is rejected before absolute expiry (A07 idle-timeout)", async () => {
  // Fresh session: 7-day absolute TTL, last_seen_at = now → within the idle window.
  const session = await createSession(db);
  const id = await verifyTokenSignature(session.token);
  expect(await validateSession(db, session.token)).not.toBeNull();

  // Back-date last_seen_at past the default 24h idle window while leaving the
  // 7-day absolute expiry firmly in the future.
  const idleAgo = new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString();
  await db.query(`UPDATE sessions SET last_seen_at = $2 WHERE id = $1`, [
    id,
    idleAgo,
  ]);

  // Rejected on idle even though expires_at has NOT been reached.
  expect(await validateSession(db, session.token)).toBeNull();
});

test("active use slides the idle window (last_seen_at refreshed on validate)", async () => {
  const session = await createSession(db);
  const id = await verifyTokenSignature(session.token);
  // Just inside the window via an explicit short idleMs override.
  const recent = new Date(Date.now() - 1000).toISOString();
  await db.query(`UPDATE sessions SET last_seen_at = $2 WHERE id = $1`, [id, recent]);
  // idleMs = 10s → 1s-old last_seen_at is still active; validate refreshes it.
  expect(await validateSession(db, session.token, { idleMs: 10_000 })).not.toBeNull();
  // After refresh, last_seen_at ≈ now, so it remains valid on the next check.
  expect(await validateSession(db, session.token, { idleMs: 10_000 })).not.toBeNull();
});

test("session cookie is Secure + HttpOnly + SameSite by default (S2)", async () => {
  const session = await createSession(db);
  const cookie = sessionCookieHeader(session);
  expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Path=/");
  expect(clearedSessionCookieHeader()).toContain("Expires=Thu, 01 Jan 1970");
});

test("Secure can be dropped ONLY via the explicit local-dev override", async () => {
  process.env.SESSION_COOKIE_INSECURE = "true";
  try {
    const session = await createSession(db);
    expect(sessionCookieHeader(session)).not.toContain("Secure");
  } finally {
    delete process.env.SESSION_COOKIE_INSECURE;
  }
  // Default restored: Secure is back.
  expect(sessionCookieHeader(await createSession(db))).toContain("Secure");
});

test("sweepExpiredSessions deletes an expired row and retains a valid row (NB-4 GC)", async () => {
  const expired = await createSession(db, { ttlMs: -1000 });
  const valid = await createSession(db);
  const expiredId = await verifyTokenSignature(expired.token);
  const validId = await verifyTokenSignature(valid.token);

  // The expired row still physically exists before a sweep — validateSession's
  // own WHERE clause only *excludes* it from matching, it never deletes it.
  expect(
    (await db.query(`SELECT id FROM sessions WHERE id = $1`, [expiredId])).length,
  ).toBe(1);

  await sweepExpiredSessions(db);

  expect(
    (await db.query(`SELECT id FROM sessions WHERE id = $1`, [expiredId])).length,
  ).toBe(0);

  // A valid (non-expired) session must never be touched by the sweep.
  expect(
    (await db.query(`SELECT id FROM sessions WHERE id = $1`, [validId])).length,
  ).toBe(1);
  expect(await validateSession(db, valid.token)).not.toBeNull();
});

test("validateSession opportunistically GCs expired rows after enough calls (NB-4)", async () => {
  const expired = await createSession(db, { ttlMs: -1000 });
  const expiredId = await verifyTokenSignature(expired.token);

  // Drive enough validateSession() calls to guarantee at least one periodic
  // sweep fires (SWEEP_INTERVAL=50 in sessions.ts — mirrors the sweep-on-
  // access pattern in rate-limit.ts). 55 calls crosses the interval
  // regardless of any leftover counter state from earlier tests in this file.
  const driver = await createSession(db);
  for (let i = 0; i < 55; i++) {
    await validateSession(db, driver.token);
  }

  expect(
    (await db.query(`SELECT id FROM sessions WHERE id = $1`, [expiredId])).length,
  ).toBe(0);
  // The active session driving the sweep must remain valid throughout.
  expect(await validateSession(db, driver.token)).not.toBeNull();
});
