// Session-metadata capture wiring (Security Center §3.2 — B1 gate blocker fix).
//
// The sessions/devices view is only useful if the sessions the operator actually
// holds carry the IP/UA captured at issuance. That means EVERY production session-
// issuance path must pass request metadata to createSession/rotateSession — not
// just revoke-others. Two proofs:
//
//  (A) ✱ fails-on-old ENUMERATION: every route that issues a session also captures
//      request metadata. On pre-fix code, 8 of the 9 issuance routes (real login,
//      recovery, register — both lanes — and the four credential-change
//      re-issuances) pass nothing → this test FAILS with a non-empty offender list;
//      after wiring all of them, it PASSES. This is the same source-enumeration
//      shape the D11 gate uses, made necessary by the module-cached getDb() that
//      makes full route handlers un-drivable against a test DB.
//  (B) behavioral PERSISTENCE: driving the real metadata-resolution + persistence
//      path (a request with x-forwarded-for + user-agent → sessionMetadataFromRequest
//      → createSession) against PGlite lands a NON-NULL trusted-proxy IP and the
//      truncated UA in the row — proving the wiring actually populates the columns,
//      not a hand-seeded value.

process.env.SESSION_SECRET = "test-session-metadata-secret-0123456789abcdef00";
process.env.OSSHP_ORIGIN = "https://osshp.example.com";
process.env.OSSHP_TRUSTED_PROXY_HOPS = "1";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  clientIp,
  createSession,
  sessionMetadataFromRequest,
  verifyTokenSignature,
} from "../index";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";

const APP_DIR = join(import.meta.dir, "../../../app");

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

// ── (A) ✱ fails-on-old: no session-issuance lane may drop request metadata ───────

test("(✱) every session-issuance route captures request metadata (no NULL-metadata lane)", () => {
  const ISSUES = /\b(?:createSession|rotateSession)\s*\(/;
  const CAPTURES = /sessionMetadataFromRequest\s*\(/;
  const offenders: string[] = [];
  for (const file of listRoutes(join(APP_DIR, "api"))) {
    const src = readFileSync(file, "utf8");
    if (ISSUES.test(src) && !CAPTURES.test(src)) {
      offenders.push(file.slice(APP_DIR.length + 1));
    }
  }
  // Pre-fix, this lists login/verify, recovery/password-totp, register/verify, and
  // the four /admin/account/* credential-change routes. All must be wired.
  expect(offenders).toEqual([]);
});

// ── (B) behavioral: the real issuance path persists request metadata ─────────────

let _h: TestDb;
let _db: Db;
beforeEach(async () => {
  _h = await createTestDb();
  _db = _h.db;
});
afterEach(async () => {
  await _h.close();
});

test("issuance from a request persists the trusted-proxy IP and the truncated user-agent", async () => {
  const ua = "Mozilla/5.0 (Macintosh) " + "x".repeat(400); // > 256 → must truncate
  const req = new Request("https://osshp.example.com/api/auth/login/verify", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": ua },
  });

  const meta = sessionMetadataFromRequest(req);
  // The IP is the trusted-proxy-resolved client IP (070) — never NULL for a
  // request with a usable XFF and configured hops.
  expect(meta.ip).toBe(clientIp(req));
  expect(meta.ip).not.toBeNull();
  expect(["203.0.113.7", "10.0.0.1"]).toContain(meta.ip);

  const issued = await createSession(_db, meta);
  const id = (await verifyTokenSignature(issued.token))!;
  const rows = await _db.query<{ created_ip: string | null; user_agent: string | null }>(
    `SELECT created_ip, user_agent FROM sessions WHERE id = $1`,
    [id],
  );
  // The persisted row carries exactly the resolved metadata — NOT NULL (the B1 bug
  // was that real lanes stored NULL and displayed the pre-v0.4.0 fallback).
  expect(rows[0].created_ip).toBe(meta.ip);
  expect(rows[0].created_ip).not.toBeNull();
  // UA is stored truncated to 256 chars (createSession enforces the bound, §3.2).
  expect(rows[0].user_agent).toBe(ua.slice(0, 256));
  expect(rows[0].user_agent!.length).toBe(256);
});
