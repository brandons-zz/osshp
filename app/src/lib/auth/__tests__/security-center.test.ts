// Security Center core (Slice 2) — revoke-others semantics, the sessions/overview
// read surface, the durable events feed, and recovery-code age. Driven against
// PGlite (real PostgreSQL in-process), so the exact production SQL — including the
// stepup_grants FK cascade and migration 0016's new columns — runs in the pre-push
// gate.
//
// The route handler itself is NOT drivable through a real DB (module-cached getDb;
// see recovery-login-routes.test.ts / stepup-routes.test.ts). So the revoke-others
// semantics are proven at the CORE the route composes: the shared gate
// (consumeStepUpGrant) + revokeOtherSessions + rotateSession, exercised end-to-end
// against real sessions and real grants. The route SURFACE (single shared gate,
// uniform 403, order of operations) is proven separately by the source-scan +
// short-circuit tests in api/admin/security/__tests__/security-routes.test.ts and
// the D11 route-enumeration test in stepup-routes.test.ts.

process.env.SESSION_SECRET = "test-security-center-session-secret-0123456789abc";
process.env.OSSHP_ORIGIN = "https://osshp.example.com";

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  SESSION_COOKIE_NAME,
  STEPUP_GRANT_HEADER,
  buildSecurityOverview,
  consumeStepUpGrant,
  createSession,
  issueStepUpGrant,
  listAuditEvents,
  listSessionsView,
  persistAuditEvent,
  buildAuditRecord,
  regenerateRecoveryCodes,
  revokeOtherSessions,
  rotateSession,
  validateSession,
  verifyTokenSignature,
} from "../index";
import { createAdminUser, getAdminUser } from "@/lib/content/admin-user";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";

const ORIGIN = "https://osshp.example.com";
let _h: TestDb;
let _db: Db;

beforeEach(async () => {
  _h = await createTestDb();
  _db = _h.db;
});
afterEach(async () => {
  await _h.close();
});

function revokeReq(token: string, grant?: string): Request {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
  };
  if (grant) headers[STEPUP_GRANT_HEADER] = grant;
  return new Request(`${ORIGIN}/api/admin/security/sessions/revoke-others`, {
    method: "POST",
    headers,
  });
}

async function sessionCount(db: Db): Promise<number> {
  const rows = await db.query<{ n: unknown }>(`SELECT COUNT(*) AS n FROM sessions`);
  return Number(rows[0]?.n ?? 0);
}
async function grantCount(db: Db): Promise<number> {
  const rows = await db.query<{ n: unknown }>(`SELECT COUNT(*) AS n FROM stepup_grants`);
  return Number(rows[0]?.n ?? 0);
}

// ── revoke-others is REFUSED without a fresh step-up grant ───────────────

test("refuse: the shared gate returns null (→ uniform 403) when no grant is presented", async () => {
  const a = await createSession(_db);
  // A valid session, but NO grant minted and NO grant header → the gate the route
  // consumes returns null, which the route maps to the uniform step-up-required 403.
  const factor = await consumeStepUpGrant(_db, revokeReq(a.token));
  expect(factor).toBeNull();
  // The session was untouched by the refused attempt.
  expect(await sessionCount(_db)).toBe(1);
});

// ── WITH a grant, revoke-others terminates every OTHER session and rotates
//    the caller's — exactly one valid session remains, and grants cascade-die ─────

test("accept: grant consumed → all other sessions terminated, caller's rotated, grants cascade", async () => {
  const a = await createSession(_db, { ip: "203.0.113.5", userAgent: "curl/8" });
  const b = await createSession(_db);
  const c = await createSession(_db);
  const aId = (await verifyTokenSignature(a.token))!;
  const bId = (await verifyTokenSignature(b.token))!;
  expect(await sessionCount(_db)).toBe(3);

  // A grant for the caller (A) and one for a soon-to-be-revoked session (B) — B's
  // must die by the stepup_grants → sessions FK cascade when B's row is deleted.
  const { grant } = await issueStepUpGrant(_db, aId, "passkey");
  await issueStepUpGrant(_db, bId, "passkey");
  expect(await grantCount(_db)).toBe(2);

  // 1) The gate consumes A's grant (single-use).
  const factor = await consumeStepUpGrant(_db, revokeReq(a.token, grant));
  expect(factor).toBe("passkey");

  // 2) Delete every OTHER session (B, C).
  const revoked = await revokeOtherSessions(_db, aId);
  expect(revoked).toBe(2);

  // 3) Rotate the caller's own session.
  const fresh = await rotateSession(_db, a.token, { ip: "203.0.113.5", userAgent: "curl/8" });

  // Post-state: exactly ONE session row remains, and it is the freshly minted one.
  expect(await sessionCount(_db)).toBe(1);
  // The caller's OLD token no longer validates (rotation revoked it).
  expect(await validateSession(_db, a.token)).toBeNull();
  // The fresh token validates.
  const survivor = await validateSession(_db, fresh.token);
  expect(survivor).not.toBeNull();
  // No grant survives — A's was consumed, B's cascade-died with B's session (§4.1).
  expect(await grantCount(_db)).toBe(0);

  // The grant is single-use: presenting it again yields the uniform-403 null.
  expect(await consumeStepUpGrant(_db, revokeReq(a.token, grant))).toBeNull();
});

// ── the sessions/overview read surface is safe + honest ──────────────────

test("sessions view: 8-char id prefixes only (no full id), exactly one current, NULL-metadata fallback", async () => {
  const a = await createSession(_db, { ip: "203.0.113.9", userAgent: "Mozilla/5.0" });
  await createSession(_db); // no metadata → NULL created_ip / user_agent (pre-v0.4.0 fallback)
  const aId = (await verifyTokenSignature(a.token))!;

  const view = await listSessionsView(_db, aId);
  expect(view).toHaveLength(2);
  // Full ids never leave the server — only 8-char prefixes.
  for (const s of view) {
    expect(s.idPrefix).toHaveLength(8);
    expect(aId.startsWith(s.idPrefix) || s.idPrefix !== aId.slice(0, 8)).toBe(true);
    expect(JSON.stringify(s)).not.toContain(aId); // the 64-char id is nowhere in the row
  }
  // Exactly one row is the caller's.
  expect(view.filter((s) => s.current)).toHaveLength(1);
  const current = view.find((s) => s.current)!;
  expect(current.createdIp).toBe("203.0.113.9");
  // The other row carries NULL metadata (display fallback, never a validity signal).
  const other = view.find((s) => !s.current)!;
  expect(other.createdIp).toBeNull();
  expect(other.userAgent).toBeNull();
});

test("overview: recovery/passkey/TOTP posture reflects the admin record", async () => {
  await createAdminUser(_db, {
    passkeyCredentials: [
      { credentialId: "c1", publicKey: "k1", counter: 0, transports: [] },
      { credentialId: "c2", publicKey: "k2", counter: 0, transports: [] },
    ] as never,
    recoveryCodes: ["h1", "h2", "h3"],
  });
  const a = await createSession(_db);
  const aId = (await verifyTokenSignature(a.token))!;

  const overview = await buildSecurityOverview(_db, aId);
  expect(overview.passkeys.count).toBe(2);
  expect(overview.recoveryCodes.remaining).toBe(3);
  expect(overview.recoveryCodes.generatedAt).toBeNull(); // no regeneration yet → honest NULL
  expect(overview.totp.enabled).toBe(false);
  expect(overview.sessions).toHaveLength(1);
});

// ── the events feed renders from the DURABLE audit store ─────────────────

test("events feed: newest-first, honors the before cursor and the server-side limit", async () => {
  const base = Date.UTC(2026, 6, 10, 0, 0, 0);
  const events = ["login.success", "passkey.enroll", "session.revoke_others"] as const;
  for (let i = 0; i < events.length; i++) {
    const rec = buildAuditRecord(events[i], "success", { details: { i } });
    (rec as { ts: string }).ts = new Date(base + i * 1000).toISOString();
    await persistAuditEvent(_db, rec);
  }

  // Newest-first: the last-inserted event is first.
  const page = await listAuditEvents(_db, {});
  expect(page).toHaveLength(3);
  expect(page[0].event).toBe("session.revoke_others");
  expect(page[2].event).toBe("login.success");

  // limit caps the page.
  const limited = await listAuditEvents(_db, { limit: 2 });
  expect(limited).toHaveLength(2);
  expect(limited[0].event).toBe("session.revoke_others");

  // before cursor returns strictly-older rows only ("load older").
  const older = await listAuditEvents(_db, { before: page[0].ts });
  expect(older.map((e) => e.event)).toEqual(["passkey.enroll", "login.success"]);

  // A malformed cursor is ignored (treated as no cursor) rather than reaching the
  // SQL timestamp comparison and throwing — the store stays total (the route also
  // rejects a malformed cursor with a 400 up front).
  const bad = await listAuditEvents(_db, { before: "not-a-timestamp" });
  expect(bad).toHaveLength(3);
});

// ── recovery-code age is stamped on regeneration and surfaced ────────────

test("recovery age: regeneration stamps recovery_codes_generated_at; overview surfaces it", async () => {
  await createAdminUser(_db, { recoveryCodes: [] });
  // Legacy set: no generation timestamp yet.
  expect((await getAdminUser(_db))!.recoveryCodesGeneratedAt).toBeNull();

  await regenerateRecoveryCodes(_db);

  const admin = await getAdminUser(_db);
  expect(admin!.recoveryCodes).toHaveLength(10);
  expect(admin!.recoveryCodesGeneratedAt).not.toBeNull();

  const a = await createSession(_db);
  const aId = (await verifyTokenSignature(a.token))!;
  const overview = await buildSecurityOverview(_db, aId);
  expect(overview.recoveryCodes.remaining).toBe(10);
  expect(overview.recoveryCodes.generatedAt).not.toBeNull();
});
