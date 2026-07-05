// The new media mutation endpoints (issue 037) are born CSRF-compliant: a
// cross-site PATCH/DELETE (the [id] route) and POST (replace) is rejected with
// 403 + Cache-Control: no-store BEFORE the handler touches the store — the [id]
// routes guard inline because they take a `params` arg the single-arg
// guardMutation wrapper can't carry (M2.1 pattern). The list GET requires a
// session (401 without one). These fail on pre-change code (the routes did not
// exist).

process.env.OSSHP_ORIGIN = "https://osshp.example.com";
// The list/usage GETs call getDb() (postgres.js is lazy — no connection is opened
// until a query runs, and an unauthenticated request returns before any query),
// so a dummy URL is enough to satisfy config without a live database.
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/osshp_test";

import { expect, test } from "bun:test";

function crossSite(method: string, path: string): Request {
  return new Request(`https://osshp.example.com${path}`, {
    method,
    headers: {
      origin: "https://evil.example.com",
      "content-type": "application/json",
    },
    body: method === "GET" ? undefined : "{}",
  });
}

const idCtx = { params: Promise.resolve({ id: "abc" }) };

test("media alt edit (PATCH [id]) rejects a cross-site request with 403 + no-store", async () => {
  const { PATCH } = (await import("@/app/api/admin/media/[id]/route")) as {
    PATCH: (r: Request, c: typeof idCtx) => Promise<Response>;
  };
  const res = await PATCH(crossSite("PATCH", "/api/admin/media/abc"), idCtx);
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("media delete (DELETE [id]) rejects a cross-site request with 403 + no-store", async () => {
  const { DELETE } = (await import("@/app/api/admin/media/[id]/route")) as {
    DELETE: (r: Request, c: typeof idCtx) => Promise<Response>;
  };
  const res = await DELETE(crossSite("DELETE", "/api/admin/media/abc"), idCtx);
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("media replace (POST replace) rejects a cross-site request with 403 + no-store", async () => {
  const { POST } = (await import("@/app/api/admin/media/[id]/replace/route")) as {
    POST: (r: Request, c: typeof idCtx) => Promise<Response>;
  };
  const res = await POST(crossSite("POST", "/api/admin/media/abc/replace"), idCtx);
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("media list (GET) requires a session — 401 + no-store without one", async () => {
  const { GET } = (await import("@/app/api/admin/media/route")) as {
    GET: (r: Request) => Promise<Response>;
  };
  // Same-origin (GET is a safe method — no CSRF), but no session cookie.
  const res = await GET(
    new Request("https://osshp.example.com/api/admin/media", { method: "GET" }),
  );
  expect(res.status).toBe(401);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("media usage (GET [id]/usage) requires a session — 401 without one", async () => {
  const { GET } = (await import("@/app/api/admin/media/[id]/usage/route")) as {
    GET: (r: Request, c: typeof idCtx) => Promise<Response>;
  };
  const res = await GET(
    new Request("https://osshp.example.com/api/admin/media/abc/usage", {
      method: "GET",
    }),
    idCtx,
  );
  expect(res.status).toBe(401);
});
