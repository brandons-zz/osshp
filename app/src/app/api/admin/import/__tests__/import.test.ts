// POST /api/admin/import requires an authenticated session — same admin-surface
// pattern as every other /api/admin/* route (getSessionFromRequest). This test
// exercises only the no-cookie path: readSessionCookie/validateSession
// short-circuit on a missing token before any DB query runs (see
// lib/auth/sessions.ts validateSession), so this is safe to run with no live
// Postgres — matching export.test.ts's convention for this same class of route.
// Full functional coverage (created/skipped/error reporting, all three modes,
// media ingestion, lossless round-trip) lives at the lib/import level
// (src/lib/import/__tests__/importer.test.ts), same split the export module uses.

process.env.DATABASE_URL = "postgres://localhost/osshp_test_placeholder";
process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-prod";
process.env.OSSHP_ORIGIN = "https://osshp.example.com";

import { expect, test } from "bun:test";

test("import rejects an unauthenticated request with 401", async () => {
  const { POST } = (await import("../route")) as {
    POST: (r: Request) => Promise<Response>;
  };
  const form = new FormData();
  form.set("mode", "skip");
  form.set("file", new File(["---\ntitle: \"X\"\n---\n\nbody\n"], "x.md"));
  const res = await POST(
    new Request("https://osshp.example.com/api/admin/import", {
      method: "POST",
      headers: { origin: "https://osshp.example.com" },
      body: form,
    }),
  );
  expect(res.status).toBe(401);
});
