// Every new/changed mutating pages route is CSRF-guarded: a cross-site POST or
// PATCH/DELETE is rejected with 403 + Cache-Control: no-store BEFORE the
// handler touches the content store (M2.1 guardMutation; the [id] route guards
// inline because it takes a `params` arg the single-arg wrapper can't carry).

process.env.OSSHP_ORIGIN = "https://osshp.example.com";

import { expect, test } from "bun:test";

function crossSite(method: string, path: string): Request {
  return new Request(`https://osshp.example.com${path}`, {
    method,
    headers: {
      origin: "https://evil.example.com",
      "content-type": "application/json",
    },
    body: "{}",
  });
}

test("pages create (POST) rejects a cross-site request with 403 + no-store", async () => {
  const { POST } = (await import("@/app/api/admin/pages/route")) as {
    POST: (r: Request) => Promise<Response>;
  };
  const res = await POST(crossSite("POST", "/api/admin/pages"));
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("pages edit (PATCH [id]) rejects a cross-site request with 403 + no-store", async () => {
  const { PATCH } = (await import("@/app/api/admin/pages/[id]/route")) as {
    PATCH: (
      r: Request,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
  };
  const res = await PATCH(crossSite("PATCH", "/api/admin/pages/abc"), {
    params: Promise.resolve({ id: "abc" }),
  });
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("pages delete (DELETE [id]) rejects a cross-site request with 403 + no-store", async () => {
  const { DELETE } = (await import("@/app/api/admin/pages/[id]/route")) as {
    DELETE: (
      r: Request,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
  };
  const res = await DELETE(crossSite("DELETE", "/api/admin/pages/abc"), {
    params: Promise.resolve({ id: "abc" }),
  });
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});
