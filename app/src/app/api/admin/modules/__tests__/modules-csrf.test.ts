// Modules API (issue 027): CSRF guard + auth guard unit tests.
//
// Same pattern as settings-csrf.test.ts / authoring-csrf.test.ts:
//   • Cross-site PATCH → rejected by guardMutation (403) before the handler runs.
//   • Same-origin request with no session cookie → reaches the handler, which
//     calls getSessionFromRequest. validateSession(db, null) returns null
//     immediately without a DB query, so no live database is required here.
//
// Full functional coverage of the write logic (unknown-id rejection, enable/
// disable diffing, no-op ids) lives at the lib layer:
// lib/module/__tests__/lifecycle.test.ts (setEnabledModules), matching the
// export/import split's convention for this class of route.

process.env.OSSHP_ORIGIN = "https://osshp.example.com";
process.env.DATABASE_URL = "postgres://localhost/osshp_test_placeholder";
process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-prod";

import { expect, test } from "bun:test";

function crossSite(body: unknown = {}): Request {
  return new Request("https://osshp.example.com/api/admin/modules", {
    method: "PATCH",
    headers: {
      origin: "https://evil.example.com",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function sameSite(body: unknown = {}): Request {
  return new Request("https://osshp.example.com/api/admin/modules", {
    method: "PATCH",
    headers: {
      origin: "https://osshp.example.com",
      "content-type": "application/json",
    },
    // No Cookie header → no session token.
    body: JSON.stringify(body),
  });
}

test("PATCH rejects a cross-site request with 403 + no-store", async () => {
  const { PATCH } = (await import("../route")) as {
    PATCH: (r: Request) => Promise<Response>;
  };
  const res = await PATCH(crossSite({ enabled: ["blog"] }));
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("PATCH rejects a same-origin request with no session with 401", async () => {
  const { PATCH } = (await import("../route")) as {
    PATCH: (r: Request) => Promise<Response>;
  };
  const res = await PATCH(sameSite({ enabled: ["blog"] }));
  expect(res.status).toBe(401);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("GET rejects a request with no session with 401", async () => {
  const { GET } = (await import("../route")) as {
    GET: (r: Request) => Promise<Response>;
  };
  const res = await GET(
    new Request("https://osshp.example.com/api/admin/modules", {
      headers: { origin: "https://osshp.example.com" },
    }),
  );
  expect(res.status).toBe(401);
});
