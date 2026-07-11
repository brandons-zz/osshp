// Security Center route surface (Slice 2). The module-cached getDb() prevents
// driving these handlers through a real DB (established constraint — see
// stepup-routes.test.ts); the revoke-others SEMANTICS are proven at the core in
// lib/auth/__tests__/security-center.test.ts. Here we prove the route SURFACE:
//
//  - revoke-others routes its gate through the ONE shared gate (consumeStepUpGrant)
//    and denies with the ONE shared uniform 403 (stepUpRequiredResponse), and does
//    the delete-others + rotate composition (§4.1). It hand-rolls neither the grant
//    SQL nor the error string.
//  - the mutation short-circuits: cross-site POST → 403 + no-store (guardMutation),
//    unauthenticated same-origin POST → 401 (before any DB work).
//  - the read endpoints are session-gated: no cookie → 401.

process.env.SESSION_SECRET = "test-security-routes-session-secret-0123456789ab";
process.env.OSSHP_ORIGIN = "https://osshp.example.com";
// Placeholder DB URL — never connected: the tested paths short-circuit at the CSRF
// guard (before getDb) or at validateSession(null) (getDb but no query).
process.env.DATABASE_URL = "postgres://localhost/osshp_test_placeholder";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const SEC_DIR = join(import.meta.dir, "..");
const ORIGIN = "https://osshp.example.com";

function req(path: string, method = "POST", opts: { cross?: boolean } = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: opts.cross ? "https://evil.example.com" : ORIGIN },
  });
}

// ── source-scan: single shared gate + uniform 403 + the §4.1 composition ────────

test("revoke-others routes through the shared gate + uniform 403, hand-rolls neither", () => {
  const src = readFileSync(join(SEC_DIR, "sessions/revoke-others/route.ts"), "utf8");
  expect(src).toContain("consumeStepUpGrant");
  expect(src).toContain("stepUpRequiredResponse");
  // §4.1: delete every other session, then rotate the caller's.
  expect(src).toContain("revokeOtherSessions");
  expect(src).toContain("rotateSession");
  // No route re-implements the grant SQL or the uniform error body.
  expect(src).not.toContain("stepup_grants");
  expect(src).not.toContain('"step-up required"');
});

// ── behavioral short-circuits (no DB) ───────────────────────────────────────────

test("revoke-others rejects a cross-site POST with 403 + no-store (guardMutation)", async () => {
  const { POST } = (await import(
    "@/app/api/admin/security/sessions/revoke-others/route"
  )) as { POST: (r: Request) => Promise<Response> };
  const res = await POST(req("/api/admin/security/sessions/revoke-others", "POST", { cross: true }));
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("revoke-others rejects an unauthenticated same-origin POST with 401", async () => {
  const { POST } = (await import(
    "@/app/api/admin/security/sessions/revoke-others/route"
  )) as { POST: (r: Request) => Promise<Response> };
  // No Cookie header → validateSession(null) short-circuits before any DB query.
  const res = await POST(req("/api/admin/security/sessions/revoke-others"));
  expect(res.status).toBe(401);
});

test("the read endpoints are session-gated: no session → 401", async () => {
  const overview = (await import("@/app/api/admin/security/overview/route")) as {
    GET: (r: Request) => Promise<Response>;
  };
  const events = (await import("@/app/api/admin/security/events/route")) as {
    GET: (r: Request) => Promise<Response>;
  };
  expect((await overview.GET(req("/api/admin/security/overview", "GET"))).status).toBe(401);
  expect((await events.GET(req("/api/admin/security/events", "GET"))).status).toBe(401);
});
