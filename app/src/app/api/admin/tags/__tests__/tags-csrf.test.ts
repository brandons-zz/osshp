// Every new/changed mutating tags route is CSRF-guarded: a cross-site PATCH,
// DELETE, or POST (merge) is rejected with 403 + Cache-Control: no-store
// BEFORE the handler touches the content store (M2.1; mirrors
// authoring-csrf.test.ts for blog/photos/pages).

process.env.OSSHP_ORIGIN = "https://osshp.example.com";
// The GET route's 401 check reads a session (short-circuits before touching
// the DB when no cookie is sent), but getDb() itself needs a DATABASE_URL to
// construct — never actually connected to in this test (media-csrf.test.ts
// precedent).
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/osshp_test";

import { expect, test } from "bun:test";

function crossSite(method: string, path: string, body?: unknown): Request {
  return new Request(`https://osshp.example.com${path}`, {
    method,
    headers: {
      origin: "https://evil.example.com",
      "content-type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : "{}",
  });
}

test("tags rename (PATCH [id]) rejects a cross-site request with 403 + no-store", async () => {
  const { PATCH } = (await import("@/app/api/admin/tags/[id]/route")) as {
    PATCH: (
      r: Request,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
  };
  const res = await PATCH(crossSite("PATCH", "/api/admin/tags/abc", { name: "X" }), {
    params: Promise.resolve({ id: "abc" }),
  });
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("tags delete (DELETE [id]) rejects a cross-site request with 403 + no-store", async () => {
  const { DELETE } = (await import("@/app/api/admin/tags/[id]/route")) as {
    DELETE: (
      r: Request,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
  };
  const req = new Request("https://osshp.example.com/api/admin/tags/abc", {
    method: "DELETE",
    headers: { origin: "https://evil.example.com" },
  });
  const res = await DELETE(req, { params: Promise.resolve({ id: "abc" }) });
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("tags merge (POST [id]/merge) rejects a cross-site request with 403 + no-store", async () => {
  const { POST } = (await import("@/app/api/admin/tags/[id]/merge/route")) as {
    POST: (
      r: Request,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
  };
  const res = await POST(
    crossSite("POST", "/api/admin/tags/abc/merge", { targetId: "def" }),
    { params: Promise.resolve({ id: "abc" }) },
  );
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("tags list (GET) rejects an unauthenticated request with 401", async () => {
  const { GET } = (await import("@/app/api/admin/tags/route")) as {
    GET: (r: Request) => Promise<Response>;
  };
  const res = await GET(
    new Request("https://osshp.example.com/api/admin/tags"),
  );
  expect(res.status).toBe(401);
});
