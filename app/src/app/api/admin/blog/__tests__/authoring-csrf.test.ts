// Every new/changed mutating authoring route is CSRF-guarded: a cross-site POST
// (or PATCH) is rejected with 403 + Cache-Control: no-store BEFORE the handler
// touches the content store (M2.1 guardMutation; the [id] route guards inline
// because it takes a `params` arg the single-arg wrapper can't carry).

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

test("blog create (POST) rejects a cross-site request with 403 + no-store", async () => {
  const { POST } = (await import("@/app/api/admin/blog/posts/route")) as {
    POST: (r: Request) => Promise<Response>;
  };
  const res = await POST(crossSite("POST", "/api/admin/blog/posts"));
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("blog preview (POST) rejects a cross-site request with 403 + no-store", async () => {
  const { POST } = (await import("@/app/api/admin/blog/preview/route")) as {
    POST: (r: Request) => Promise<Response>;
  };
  const res = await POST(crossSite("POST", "/api/admin/blog/preview"));
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("blog edit (PATCH [id]) rejects a cross-site request with 403 + no-store", async () => {
  const { PATCH } = (await import("@/app/api/admin/blog/posts/[id]/route")) as {
    PATCH: (
      r: Request,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
  };
  const res = await PATCH(crossSite("PATCH", "/api/admin/blog/posts/abc"), {
    params: Promise.resolve({ id: "abc" }),
  });
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("blog delete (DELETE [id]) rejects a cross-site request with 403 + no-store", async () => {
  const { DELETE } = (await import("@/app/api/admin/blog/posts/[id]/route")) as {
    DELETE: (
      r: Request,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
  };
  const req = new Request("https://osshp.example.com/api/admin/blog/posts/abc", {
    method: "DELETE",
    headers: { origin: "https://evil.example.com" },
  });
  const res = await DELETE(req, { params: Promise.resolve({ id: "abc" }) });
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("photos delete (DELETE [id]) rejects a cross-site request with 403 + no-store", async () => {
  const { DELETE } = (await import("@/app/api/admin/photos/posts/[id]/route")) as {
    DELETE: (
      r: Request,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
  };
  const req = new Request(
    "https://osshp.example.com/api/admin/photos/posts/abc",
    {
      method: "DELETE",
      headers: { origin: "https://evil.example.com" },
    },
  );
  const res = await DELETE(req, { params: Promise.resolve({ id: "abc" }) });
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});
