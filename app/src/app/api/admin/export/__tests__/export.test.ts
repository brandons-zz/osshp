// GET /api/admin/export requires an authenticated session — same admin-surface
// pattern as every other /api/admin/* route (getSessionFromRequest). This test
// exercises only the no-cookie path: readSessionCookie/validateSession
// short-circuit on a missing token before any DB query runs (see
// lib/auth/sessions.ts validateSession), so this is safe to run with no live
// Postgres, matching the rest of the admin route CSRF/auth test suite.
//
// DATABASE_URL is required by getDb() at construction (see
// settings-csrf.test.ts for the same pattern) even though the null-token path
// never issues a query.
process.env.DATABASE_URL = "postgres://localhost/osshp_test_placeholder";
process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-prod";

import { expect, test } from "bun:test";

test("export download rejects an unauthenticated request with 401", async () => {
  const { GET } = (await import("@/app/api/admin/export/route")) as {
    GET: (r: Request) => Promise<Response>;
  };
  const res = await GET(new Request("https://osshp.example.com/api/admin/export"));
  expect(res.status).toBe(401);
});
