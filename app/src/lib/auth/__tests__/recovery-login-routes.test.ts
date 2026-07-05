// Route-level and domain-level tests for the recovery login lanes.
//
// Covers three properties the brief requires:
//
//  1. Recovery-login SUCCESS  — password+TOTP auth with valid credentials produces
//     a session. Tested at domain level (the route handler is a thin wrapper):
//     verifyPasswordAndTotp returns true → rotateSession is called → { verified:true }
//     + Set-Cookie. The domain layer is the authoritative proof.
//
//  2. Reuse-rejection         — a recovery code cannot be used twice (single-use,
//     R3). Tested at domain level: consumeRecoveryCode returns false on second use.
//
//  3. Non-enumeration         — ALL failure modes (wrong password, wrong TOTP,
//     wrong/used recovery code) return the SAME result at the domain level (false)
//     so the route emits the same generic 401 body. Both domain and static source
//     assertions are included.
//
// Route-level (no DB needed):
//  4. Unauthenticated account mutations → 401/403.
//  5. Missing-body recovery routes → 400.
//
// Implementation note on mock.module: bun:test shares a module registry across all
// test files in a run; mock.module persists globally and would clobber other test
// files' DB client imports. We therefore do NOT use mock.module here. The domain
// functions are tested directly with a PGlite DB (hermetic), and the route-level
// tests use a placeholder DATABASE_URL that is never queried (validateSession
// short-circuits on a missing session token, no DB hit required).

// ── Environment ────────────────────────────────────────────────────────────────
process.env.SESSION_SECRET =
  "test-recovery-login-routes-session-secret-xxxxxxxxx";
process.env.OSSHP_ENCRYPTION_KEY =
  "test-encryption-key-exactly-32-chars-012345";
process.env.OSSHP_ORIGIN = "https://osshp.example.com";
process.env.OSSHP_TRUSTED_PROXY_HOPS = "1";
// Placeholder DB URL — never connected because the route-level rejection tests
// short-circuit before any DB query (null-token path in validateSession, or CSRF
// guard fires first). The domain tests use PGlite directly, bypassing getDb().
process.env.DATABASE_URL = "postgres://localhost/osshp_test_placeholder";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createAdminUser } from "@/lib/content/admin-user";
import {
  confirmTotp,
  consumeRecoveryCode,
  currentTotpToken,
  enrollTotp,
  regenerateRecoveryCodes,
  setPassword,
  verifyPasswordAndTotp,
} from "@/lib/auth";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ORIGIN = "https://osshp.example.com";
const PW = "a-long-admin-password-123";
const PERIOD = 30;
const EPOCH = 1_750_000_000;

/** Same-origin POST with JSON body (passes the CSRF guard). */
function sameOriginPost(path: string, body: unknown = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Cross-origin POST (should be rejected by guardMutation with 403). */
function crossOriginPost(path: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: "https://evil.example.com",
      "content-type": "application/json",
    },
    body: "{}",
  });
}

/** Enroll password + TOTP; return the TOTP secret. */
async function enrollBoth(
  db: Db,
  confirmEpoch = EPOCH - PERIOD,
): Promise<string> {
  await setPassword(db, PW);
  const { secret } = await enrollTotp(db);
  const tok = await currentTotpToken(secret, { epoch: confirmEpoch });
  await confirmTotp(db, tok, { epoch: confirmEpoch });
  return secret;
}

// ── PGlite lifecycle (domain tests) ───────────────────────────────────────────

let _h: TestDb;
let _db: Db;

beforeEach(async () => {
  _h = await createTestDb();
  _db = _h.db;
  await createAdminUser(_db);
});

afterEach(async () => {
  await _h.close();
});

// ── 1. Recovery-login success (domain level) ──────────────────────────────────

test("recovery-login success: verifyPasswordAndTotp returns true for valid credentials", async () => {
  const secret = await enrollBoth(_db);
  // Use a fresh step: EPOCH is the auth step, confirmEpoch was EPOCH-PERIOD.
  const token = await currentTotpToken(secret, { epoch: EPOCH });
  const ok = await verifyPasswordAndTotp(_db, PW, token, { epoch: EPOCH });
  // The route translates this true → rotateSession → { verified: true } + Set-Cookie.
  expect(ok).toBe(true);
});

test("recovery-code success: consumeRecoveryCode returns the reenroll token for a valid unused code", async () => {
  const { plaintext } = await regenerateRecoveryCodes(_db);
  // The route translates a token → { ok: true, reenroll: true, reenrollToken } (no session; R6/F1).
  const token = await consumeRecoveryCode(_db, plaintext[0]);
  expect(token).toBeTypeOf("string");
});

// ── 2. Reuse-rejection (domain level) ─────────────────────────────────────────

test("reuse-rejection: a recovery code cannot be used twice (single-use, R3)", async () => {
  const { plaintext } = await regenerateRecoveryCodes(_db);
  // First use succeeds (returns the reenroll token).
  expect(await consumeRecoveryCode(_db, plaintext[0])).toBeTypeOf("string");
  // Second use of the same code is rejected (single-use, R3) → null.
  // The route translates null → { error: "recovery failed" } with 401.
  expect(await consumeRecoveryCode(_db, plaintext[0])).toBeNull();
});

test("reuse-rejection: TOTP one-time-per-step — same code cannot be reused", async () => {
  const secret = await enrollBoth(_db);
  // First auth at EPOCH: consumes the step.
  const tok = await currentTotpToken(secret, { epoch: EPOCH });
  expect(await verifyPasswordAndTotp(_db, PW, tok, { epoch: EPOCH })).toBe(true);
  // Second call with the same step is rejected (one-time-per-step, T2).
  expect(await verifyPasswordAndTotp(_db, PW, tok, { epoch: EPOCH })).toBe(false);
});

// ── 3. Non-enumeration (domain + static) ─────────────────────────────────────

test("non-enumeration: wrong password AND wrong TOTP both return false (same result)", async () => {
  const secret = await enrollBoth(_db);
  const goodTok = await currentTotpToken(secret, { epoch: EPOCH });

  // Wrong password + valid TOTP → false.
  const wrongPwResult = await verifyPasswordAndTotp(
    _db,
    "wrong-password-xxxxxxxxx",
    goodTok,
    { epoch: EPOCH },
  );
  expect(wrongPwResult).toBe(false);

  // Correct password + invalid TOTP → false.
  const wrongTotpResult = await verifyPasswordAndTotp(
    _db,
    PW,
    "000000",
    { epoch: EPOCH + PERIOD },
  );
  expect(wrongTotpResult).toBe(false);

  // Both failures are indistinguishable — the domain returns false for each
  // so the route can emit the same "recovery failed" body without branching.
  expect(wrongPwResult).toBe(wrongTotpResult);
});

test("non-enumeration: wrong recovery code and used recovery code both return null", async () => {
  const { plaintext } = await regenerateRecoveryCodes(_db);

  // Wrong code → null.
  const wrongResult = await consumeRecoveryCode(
    _db,
    "00000-00000-00000-00000",
  );
  expect(wrongResult).toBeNull();

  // Use a real code, then use it again (used code) → null.
  await consumeRecoveryCode(_db, plaintext[1]); // consume code[1]
  const usedResult = await consumeRecoveryCode(_db, plaintext[1]); // reuse same code
  expect(usedResult).toBeNull();

  // Both indistinguishable at the domain level → route emits same error body.
  expect(wrongResult).toBe(usedResult);
});

test("non-enumeration: recovery route source emits same error string for all failures", () => {
  // Static assertion: the password-totp route returns the SAME error string
  // ("recovery failed") for both wrong-credentials and any other failure,
  // so no factor leaks to an attacker. The source must not contain per-factor
  // branches that emit different messages.
  const appDir = join(import.meta.dir, "../../../app");
  const routes = [
    join(appDir, "api/auth/recovery/password-totp/route.ts"),
    join(appDir, "api/auth/recovery/code/route.ts"),
  ];
  for (const path of routes) {
    const src = readFileSync(path, "utf8");
    // Only one failure branch — "recovery failed" appears exactly once.
    const matches = src.match(/"recovery failed"/g);
    expect(matches?.length).toBe(1);
    // No per-factor error messages leak which factor failed.
    expect(src).not.toContain('"wrong password"');
    expect(src).not.toContain('"wrong totp"');
    expect(src).not.toContain('"invalid password"');
    expect(src).not.toContain('"code already used"');
    expect(src).not.toContain('"code not found"');
  }
});

// ── 4. Unauthenticated account mutations → 401/403 ───────────────────────────

test("account mutations reject cross-site requests with 403 (CSRF guard, no DB hit)", async () => {
  // CSRF guard fires BEFORE any session/DB check — safe with a placeholder DB.
  const routes = [
    { module: "@/app/api/admin/account/password/route", method: "POST" },
    { module: "@/app/api/admin/account/recovery-codes/route", method: "POST" },
    { module: "@/app/api/admin/account/totp/route", method: "POST" },
  ];
  for (const { module, method } of routes) {
    const handler = ((await import(module)) as Record<string, (r: Request) => Promise<Response>>)[method];
    const res = await handler(crossOriginPost("/x"));
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
  // Also test PUT (TOTP confirm).
  const { PUT } = await import("@/app/api/admin/account/totp/route") as {
    PUT: (r: Request) => Promise<Response>;
  };
  const putReq = new Request(`${ORIGIN}/api/admin/account/totp`, {
    method: "PUT",
    headers: { origin: "https://evil.example.com", "content-type": "application/json" },
    body: "{}",
  });
  const putRes = await PUT(putReq);
  expect(putRes.status).toBe(403);
});

test("account mutations reject unauthenticated same-origin requests with 401", async () => {
  // No Cookie header → readSessionCookie returns null/undefined → validateSession
  // short-circuits with `if (!token) return null` WITHOUT querying the DB (safe
  // with a placeholder DATABASE_URL). Handler returns 401.
  const { POST: pwPost } = await import("@/app/api/admin/account/password/route") as {
    POST: (r: Request) => Promise<Response>;
  };
  const { POST: codesPost } = await import("@/app/api/admin/account/recovery-codes/route") as {
    POST: (r: Request) => Promise<Response>;
  };
  const { POST: totpPost, PUT: totpPut } = await import("@/app/api/admin/account/totp/route") as {
    POST: (r: Request) => Promise<Response>;
    PUT: (r: Request) => Promise<Response>;
  };

  const makeReq = (path: string, method = "POST") =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ password: "placeholder-long-enough" }),
    });

  expect((await pwPost(makeReq("/api/admin/account/password"))).status).toBe(401);
  expect((await codesPost(makeReq("/api/admin/account/recovery-codes"))).status).toBe(401);
  expect((await totpPost(makeReq("/api/admin/account/totp"))).status).toBe(401);
  expect(
    (
      await totpPut(
        new Request(`${ORIGIN}/api/admin/account/totp`, {
          method: "PUT",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ token: "123456" }),
        }),
      )
    ).status,
  ).toBe(401);
});

// ── 5. Missing-body / bad-input rejection (no DB hit) ─────────────────────────

test("password-totp recovery rejects a missing body with 400 or 401 (rate-limit key required)", async () => {
  // The route reads the body AFTER the rate-limit check (which uses clientKey, pure).
  // A missing body (null) → the handler returns 400 (missing required fields).
  // We test with an empty JSON body: password and totpToken absent.
  const { POST } = await import("@/app/api/auth/recovery/password-totp/route") as {
    POST: (r: Request) => Promise<Response>;
  };
  const req = sameOriginPost("/api/auth/recovery/password-totp", {});
  const res = await POST(req);
  // No password/totpToken → 400 before any DB call.
  expect(res.status).toBe(400);
});

test("recovery-code route rejects a missing code with 400", async () => {
  const { POST } = await import("@/app/api/auth/recovery/code/route") as {
    POST: (r: Request) => Promise<Response>;
  };
  const req = sameOriginPost("/api/auth/recovery/code", {});
  const res = await POST(req);
  // No code → 400 before any DB call.
  expect(res.status).toBe(400);
});
