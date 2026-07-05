// Photo-post media-cleanup surfaces (issue 056) inherit the module's guards:
//   - DELETE …/photos/posts/[id]  (with ?deleteMedia=1) — inline same-origin CSRF
//     (403 cross-site) because it takes the route `params` arg.
//   - GET …/photos/posts/[id]/media (the cleanup preview) — session-required
//     (401 without one); a safe method, so no CSRF guard.
// These fail on pre-change code (the preview route + deleteMedia opt-in did not
// exist).

process.env.OSSHP_ORIGIN = "https://osshp.example.com";
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/osshp_test";

import { expect, test } from "bun:test";

const idCtx = { params: Promise.resolve({ id: "abc" }) };

test("photo-post DELETE rejects a cross-site request with 403 + no-store", async () => {
  const { DELETE } = (await import(
    "@/app/api/admin/photos/posts/[id]/route"
  )) as { DELETE: (r: Request, c: typeof idCtx) => Promise<Response> };
  const res = await DELETE(
    new Request(
      "https://osshp.example.com/api/admin/photos/posts/abc?deleteMedia=1",
      {
        method: "DELETE",
        headers: { origin: "https://evil.example.com" },
      },
    ),
    idCtx,
  );
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("media-cleanup preview GET requires a session — 401 without one", async () => {
  const { GET } = (await import(
    "@/app/api/admin/photos/posts/[id]/media/route"
  )) as { GET: (r: Request, c: typeof idCtx) => Promise<Response> };
  const res = await GET(
    new Request("https://osshp.example.com/api/admin/photos/posts/abc/media", {
      method: "GET",
    }),
    idCtx,
  );
  expect(res.status).toBe(401);
  expect(res.headers.get("cache-control")).toBe("no-store");
});
