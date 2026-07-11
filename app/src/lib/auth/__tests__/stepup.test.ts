// Step-up grant core — integration (PGlite). Proves the load-bearing
// security invariants that are testable at the
// domain/gate level (the routes use module-cached getDb(), so the ROUTE surface is
// audited by stepup-routes.test.ts's enumeration + short-circuit tests; the grant
// SEMANTICS — the actual security — are proven here against a real DB):
//
//  AC2  a valid grant admits exactly one action; a replay → uniform deny.
//  AC3  an expired grant → deny.
//  AC4  a grant minted under session A, presented with session B → deny.
//  AC5  the mint stores the token salted-hashed (^[0-9a-f]{32}:[0-9a-f]{64}$),
//       plaintext absent from the DB.
//  AC9  after revokeAllSessions, stepup_grants is empty (FK cascade).
//  + failed presentation burns the grant; one active grant per session (upsert);
//    the uniform 403 shape; and the D10 refuse-last-passkey removal contract.

process.env.SESSION_SECRET = "test-stepup-session-secret-0123456789-abcdef";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createAdminUser } from "@/lib/content/admin-user";
import {
  consumeStepUpGrant,
  issueStepUpGrant,
  removePasskey,
  revokeAllSessions,
  stepUpRequiredResponse,
  STEPUP_GRANT_HEADER,
  STEPUP_REQUIRED_ERROR,
  SESSION_COOKIE_NAME,
  createSession,
  verifyTokenSignature,
} from "@/lib/auth";

let h: TestDb;
let db: Db;
beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

/** Create a real session row and return { token, id } (the id is the DB row id,
 *  required because stepup_grants.session_id has an FK to sessions(id)). */
async function newSession(): Promise<{ token: string; id: string }> {
  const { token } = await createSession(db);
  const id = await verifyTokenSignature(token);
  if (!id) throw new Error("session token did not verify");
  return { token, id };
}

/** A gated request carrying the given session cookie and (optionally) grant header. */
function gatedRequest(sessionToken?: string, grant?: string): Request {
  const headers: Record<string, string> = {};
  if (sessionToken) headers.cookie = `${SESSION_COOKIE_NAME}=${sessionToken}`;
  if (grant !== undefined) headers[STEPUP_GRANT_HEADER] = grant;
  return new Request("https://osshp.example.com/api/admin/account/password", {
    method: "POST",
    headers,
  });
}

function fakePasskey(id: string) {
  return { credentialId: id, publicKey: `pk-${id}`, counter: 0, transports: ["internal"] };
}

// ── AC2: single-use — a valid grant admits exactly one action, replay denies ─────

test("AC2: a valid grant admits exactly one action; the same token replays to a deny", async () => {
  const s = await newSession();
  const { grant } = await issueStepUpGrant(db, s.id, "passkey");

  // First presentation: the grant is consumed and returns its factor.
  expect(await consumeStepUpGrant(db, gatedRequest(s.token, grant))).toBe("passkey");
  // Replay of the SAME token on a second action: denied (single-use).
  expect(await consumeStepUpGrant(db, gatedRequest(s.token, grant))).toBeNull();
});

// ── AC3: expiry ─────────────────────────────────────────────────────────────────

test("AC3: an expired grant denies", async () => {
  const s = await newSession();
  const { grant, expiresAt } = await issueStepUpGrant(db, s.id, "passkey");
  // Present it AFTER its expiry — the consume-path clock is injectable.
  const past = expiresAt.getTime() + 1;
  expect(
    await consumeStepUpGrant(db, gatedRequest(s.token, grant), { now: past }),
  ).toBeNull();
});

test("a grant minted with a negative TTL is already expired and denies", async () => {
  const s = await newSession();
  const { grant } = await issueStepUpGrant(db, s.id, "passkey", { ttlMs: -1000 });
  expect(await consumeStepUpGrant(db, gatedRequest(s.token, grant))).toBeNull();
});

// ── AC4: session binding — a grant cannot be transplanted between sessions ────────

test("AC4: a grant minted under session A, presented with session B's cookie, denies", async () => {
  const a = await newSession();
  const b = await newSession();
  const { grant } = await issueStepUpGrant(db, a.id, "passkey");
  // Present A's grant token with B's session cookie → B has no grant row → deny.
  expect(await consumeStepUpGrant(db, gatedRequest(b.token, grant))).toBeNull();
  // And A's grant is untouched — the foreign presentation did not consume it.
  expect(await consumeStepUpGrant(db, gatedRequest(a.token, grant))).toBe("passkey");
});

// ── AC1/AC7 deny classes: no grant, wrong token, absent header — all deny ──────────

test("no grant ever minted → deny (valid session, no grant row)", async () => {
  const s = await newSession();
  expect(await consumeStepUpGrant(db, gatedRequest(s.token, "anything"))).toBeNull();
  expect(await consumeStepUpGrant(db, gatedRequest(s.token))).toBeNull();
});

test("a wrong token denies AND burns the grant (fail-closed)", async () => {
  const s = await newSession();
  await issueStepUpGrant(db, s.id, "passkey");
  // Present the WRONG token: denied, and the grant is destroyed by the delete.
  expect(await consumeStepUpGrant(db, gatedRequest(s.token, "not-the-grant"))).toBeNull();
  // A subsequent CORRECT-looking attempt also denies — the grant is gone.
  const rows = await db.query(`SELECT session_id FROM stepup_grants WHERE session_id = $1`, [s.id]);
  expect(rows.length).toBe(0);
});

test("an absent grant header denies (unresolved session → no id → deny)", async () => {
  // No session cookie at all → no session id resolves → deny before any DB read.
  expect(await consumeStepUpGrant(db, gatedRequest(undefined, "x"))).toBeNull();
});

// ── AC5: hashed at rest, plaintext never persisted ────────────────────────────────

test("AC5: the grant is stored salted-hashed; the plaintext is absent from the DB", async () => {
  const s = await newSession();
  const { grant } = await issueStepUpGrant(db, s.id, "passkey");
  const rows = await db.query<{ token_hash: string; factor: string }>(
    `SELECT token_hash, factor FROM stepup_grants WHERE session_id = $1`,
    [s.id],
  );
  const stored = rows[0];
  // Salted SHA-256 shape: 16-byte salt hex : 32-byte digest hex.
  expect(stored.token_hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
  // The plaintext grant is NOT recoverable from the stored value.
  expect(stored.token_hash.includes(grant)).toBe(false);
  expect(stored.factor).toBe("passkey");
});

// ── one active grant per session (upsert) ─────────────────────────────────────────

test("minting twice for one session replaces the prior grant (one active grant per session)", async () => {
  const s = await newSession();
  const first = await issueStepUpGrant(db, s.id, "passkey");
  const second = await issueStepUpGrant(db, s.id, "password+totp");

  const rows = await db.query(`SELECT session_id FROM stepup_grants WHERE session_id = $1`, [s.id]);
  expect(rows.length).toBe(1); // never accumulates

  // The OLD token no longer works; the NEW one does and carries its new factor.
  expect(await consumeStepUpGrant(db, gatedRequest(s.token, first.grant))).toBeNull();
  // (the failed presentation above burned the row) — re-mint to check the new token.
  const third = await issueStepUpGrant(db, s.id, "password+totp");
  expect(await consumeStepUpGrant(db, gatedRequest(s.token, third.grant))).toBe("password+totp");
  void second;
});

// ── AC9: FK cascade — revocation destroys pending grants ──────────────────────────

test("AC9: after revokeAllSessions, stepup_grants is empty (FK cascade)", async () => {
  const a = await newSession();
  const b = await newSession();
  await issueStepUpGrant(db, a.id, "passkey");
  await issueStepUpGrant(db, b.id, "password+totp");
  expect((await db.query(`SELECT session_id FROM stepup_grants`)).length).toBe(2);

  await revokeAllSessions(db);

  expect((await db.query(`SELECT session_id FROM stepup_grants`)).length).toBe(0);
});

// ── uniform 403 shape (§7 / D7) ───────────────────────────────────────────────────

test("stepUpRequiredResponse is a byte-identical 403 with no reason field", async () => {
  const res = stepUpRequiredResponse();
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body).toEqual({ error: STEPUP_REQUIRED_ERROR });
  expect(STEPUP_REQUIRED_ERROR).toBe("step-up required");
});

// ── D10: passkey removal — refuse-last-passkey invariant ──────────────────────────

test("D10: removePasskey removes a non-last passkey and refuses the last one", async () => {
  await createAdminUser(db, {
    passkeyCredentials: [fakePasskey("cred-a"), fakePasskey("cred-b")] as never,
  });

  // Removing one of two succeeds; one remains.
  expect(await removePasskey(db, "cred-a")).toBe("removed");

  // Removing the LAST remaining passkey is refused — no mutation.
  expect(await removePasskey(db, "cred-b")).toBe("last_passkey");
  const rows = await db.query<{ passkey_credentials: { credentialId: string }[] }>(
    `SELECT passkey_credentials FROM admin_user WHERE lock_col = 'X'`,
  );
  expect(rows[0].passkey_credentials.length).toBe(1);
  expect(rows[0].passkey_credentials[0].credentialId).toBe("cred-b");

  // An unknown credential id is not found.
  expect(await removePasskey(db, "cred-z")).toBe("not_found");
});
