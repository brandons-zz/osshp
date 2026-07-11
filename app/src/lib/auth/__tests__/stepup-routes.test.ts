// Step-up route wiring (A1). Proves the ROUTE-surface acceptance criteria that the
// module-cached getDb() prevents driving through a real DB in a route handler
// (established codebase constraint — see recovery-login-routes.test.ts):
//
//  D11 / AC1 / AC7 (✱ fails-on-old): every gated route routes its grant check
//       through the ONE shared gate (consumeStepUpGrant) and denies with the ONE
//       shared uniform 403 (stepUpRequiredResponse). On pre-change code none of the
//       five routes references either symbol, so this test fails on old and passes
//       on new — the route-enumeration invariant of D11 (the 051/066 lesson).
//  D9   (✱ fails-on-old): register/verify's step-up branch now revokes all sessions
//       and issues a fresh cookie — absent from pre-change code.
//  §7/§6.3: the fallback lane emits ONE generic failure string (no factor oracle).
//  short-circuit behavioral: the new step-up routes reject cross-site POSTs (CSRF)
//       and unauthenticated same-origin POSTs (401) before any DB query.

process.env.SESSION_SECRET = "test-stepup-routes-session-secret-0123456789";
process.env.OSSHP_ORIGIN = "https://osshp.example.com";
process.env.OSSHP_TRUSTED_PROXY_HOPS = "1";
// Placeholder DB URL — never connected: the tested paths short-circuit at the CSRF
// guard (before getDb) or at validateSession(null) (getDb but no query).
process.env.DATABASE_URL = "postgres://localhost/osshp_test_placeholder";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  createRateLimiter,
  clientKey,
  stepupLimiter,
  stepupFallbackLimiter,
  passwordTotpLimiter,
  stepupChallengeCookieHeader,
  STEPUP_CHALLENGE_COOKIE_NAME,
} from "@/lib/auth";
import { createTestDb } from "@/lib/db/test-support";

const APP_DIR = join(import.meta.dir, "../../../app");
const ORIGIN = "https://osshp.example.com";

/** The state-touching requests that MUST route through the single shared gate.
 *  The Security Center's revoke-others (asymmetric session eviction) is the +1
 *  this slice adds to the A1 D11 enumeration (§4.2) — logout stays ungated. */
const GATED_ROUTE_FILES = [
  "api/admin/account/password/route.ts",
  "api/admin/account/totp/route.ts",
  "api/admin/account/recovery-codes/route.ts",
  "api/auth/register/options/route.ts",
  "api/admin/account/passkeys/[credentialId]/route.ts",
  "api/admin/security/sessions/revoke-others/route.ts",
];

function sameOriginReq(path: string, method = "POST"): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: method === "DELETE" ? undefined : "{}",
  });
}

function crossOriginReq(path: string, method = "POST"): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: "https://evil.example.com", "content-type": "application/json" },
    body: method === "DELETE" ? undefined : "{}",
  });
}

// ── D11 / AC1 / AC7 (✱): single shared gate across every gated route ──────────────

test("(✱ D11) every gated route routes through the ONE shared gate and uniform 403", () => {
  for (const rel of GATED_ROUTE_FILES) {
    const src = readFileSync(join(APP_DIR, rel), "utf8");
    // The route imports and calls the single shared gate — not a re-implementation.
    expect(src).toContain("consumeStepUpGrant");
    // …and denies with the ONE shared uniform-403 helper (byte-identical body).
    expect(src).toContain("stepUpRequiredResponse");
    // No route hand-rolls the grant SQL or the error string.
    expect(src).not.toContain("stepup_grants");
    expect(src).not.toContain('"step-up required"');
  }
});

test("(✱ D11) exactly the five known routes reference the shared gate — set is complete", () => {
  // A guard against a NEW credential route silently shipping gated-or-ungated
  // outside the audited set: any route.ts referencing consumeStepUpGrant must be
  // one of the five (the design's §3 table). A sixth forces an intentional update.
  const gated = listRoutes(join(APP_DIR, "api")).filter((f) =>
    readFileSync(f, "utf8").includes("consumeStepUpGrant"),
  );
  const gatedRel = gated.map((f) => f.slice(join(APP_DIR).length + 1)).sort();
  expect(gatedRel).toEqual([...GATED_ROUTE_FILES].sort());
});

/** Recursively list every route.ts under a dir. */
function listRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listRoutes(full));
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

// ── D9 (✱): register/verify step-up enroll now revokes all + fresh cookie ─────────

test("(✱ D9) register/verify's step-up enroll revokes all sessions and issues a fresh cookie", () => {
  const src = readFileSync(join(APP_DIR, "api/auth/register/verify/route.ts"), "utf8");
  // Pre-change code never revoked on step-up enroll — this symbol is absent there.
  expect(src).toContain("revokeAllSessions");
  expect(src).toContain("passkey_enroll");
});

// ── §6.3 / §7: fallback lane emits ONE generic failure (no factor oracle) ─────────

test("the fallback step-up lane emits a single generic failure string (no factor leak)", () => {
  const src = readFileSync(join(APP_DIR, "api/auth/stepup/password-totp/route.ts"), "utf8");
  expect(src.match(/"step-up failed"/g)?.length).toBe(1);
  for (const leak of ['"wrong password"', '"invalid password"', '"wrong totp"', '"invalid totp"']) {
    expect(src).not.toContain(leak);
  }
});

// ── short-circuit behavioral: CSRF 403 before any DB query ────────────────────────

test("new step-up routes reject a cross-site POST with 403 + no-store (guardMutation)", async () => {
  const routes = [
    "@/app/api/auth/stepup/options/route",
    "@/app/api/auth/stepup/verify/route",
    "@/app/api/auth/stepup/password-totp/route",
  ];
  for (const mod of routes) {
    const { POST } = (await import(mod)) as { POST: (r: Request) => Promise<Response> };
    const res = await POST(crossOriginReq("/x"));
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
  const { DELETE } = (await import("@/app/api/admin/account/passkeys/[credentialId]/route")) as {
    DELETE: (r: Request) => Promise<Response>;
  };
  const del = await DELETE(crossOriginReq("/api/admin/account/passkeys/abc", "DELETE"));
  expect(del.status).toBe(403);
  expect(del.headers.get("cache-control")).toBe("no-store");
});

// ── short-circuit behavioral: 401 for an unauthenticated same-origin request ──────

test("new step-up routes reject an unauthenticated same-origin request with 401", async () => {
  const routes = [
    "@/app/api/auth/stepup/options/route",
    "@/app/api/auth/stepup/verify/route",
    "@/app/api/auth/stepup/password-totp/route",
  ];
  for (const mod of routes) {
    const { POST } = (await import(mod)) as { POST: (r: Request) => Promise<Response> };
    // No Cookie header → validateSession short-circuits (no token) with no DB query.
    const res = await POST(sameOriginReq("/api/auth/stepup/x"));
    expect(res.status).toBe(401);
  }
  const { DELETE } = (await import("@/app/api/admin/account/passkeys/[credentialId]/route")) as {
    DELETE: (r: Request) => Promise<Response>;
  };
  const del = await DELETE(sameOriginReq("/api/admin/account/passkeys/abc", "DELETE"));
  expect(del.status).toBe(401);
});

// ── AC6: the fallback lockout lane is independent of the recovery-login lane ──────

test("the step-up fallback lane is a distinct limiter from the recovery-login and passkey lanes", () => {
  // Independent instances → an independent key space → step-up lockout state and
  // recovery-login lockout state cannot bleed into one another (own key lane).
  expect(stepupFallbackLimiter).not.toBe(passwordTotpLimiter);
  expect(stepupFallbackLimiter).not.toBe(stepupLimiter);
});

test("the fallback lane has B4 lockout shape: N failures lock, a success resets", async () => {
  // Mirror the exported fallback limiter's shape (name + config) without mutating
  // the shared singleton; exercise the persisted limiter (migration 0013) against
  // a hermetic PGlite db (recovery-routes.test.ts pattern, post-A2 refactor).
  const { db, close } = await createTestDb();
  try {
    const limiter = createRateLimiter({
      name: "stepup-password-totp",
      windowMs: 5 * 60_000,
      max: 5,
      globalMax: 20,
    });
    const req = new Request("https://osshp.example.com/api/auth/stepup/password-totp", {
      method: "POST",
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
    });
    const key = clientKey("stepup-password-totp", req);
    for (let i = 0; i < 5; i++) {
      expect((await limiter.check(db, key)).allowed).toBe(true);
    }
    expect((await limiter.check(db, key)).allowed).toBe(false); // 6th locks
    await limiter.reset(db, key); // success resets the counter
    expect((await limiter.check(db, key)).allowed).toBe(true);
  } finally {
    await close();
  }
});

// ── step-up ceremony cookie is scoped so it cannot cross the login ceremony ───────

test("the step-up ceremony cookie is path-scoped to /api/auth/stepup with its own name", () => {
  const header = stepupChallengeCookieHeader("ceremony-123");
  expect(STEPUP_CHALLENGE_COOKIE_NAME).toBe("osshp_stepup_ceremony");
  expect(header).toContain("osshp_stepup_ceremony=ceremony-123");
  expect(header).toContain("Path=/api/auth/stepup");
  expect(header).toContain("HttpOnly");
  expect(header).toContain("SameSite=Lax");
});
