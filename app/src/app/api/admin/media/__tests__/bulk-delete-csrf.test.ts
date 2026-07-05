// The bulk-delete endpoint (issue 057) is born CSRF-compliant and default-deny:
// a cross-site POST is rejected 403 + no-store BEFORE the handler touches the
// store (guardMutation, the single-arg wrapper — this route takes only the
// Request). A same-origin POST without a session is 401. These fail on
// pre-change code (the route did not exist).

process.env.OSSHP_ORIGIN = "https://osshp.example.com";
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/osshp_test";

import { expect, test } from "bun:test";

test("bulk-delete rejects a cross-site POST with 403 + no-store", async () => {
  const { POST } = (await import(
    "@/app/api/admin/media/bulk-delete/route"
  )) as { POST: (r: Request) => Promise<Response> };
  const res = await POST(
    new Request("https://osshp.example.com/api/admin/media/bulk-delete", {
      method: "POST",
      headers: {
        origin: "https://evil.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ids: ["abc"] }),
    }),
  );
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("bulk-delete requires a session — 401 same-origin without one", async () => {
  const { POST } = (await import(
    "@/app/api/admin/media/bulk-delete/route"
  )) as { POST: (r: Request) => Promise<Response> };
  const res = await POST(
    new Request("https://osshp.example.com/api/admin/media/bulk-delete", {
      method: "POST",
      headers: {
        origin: "https://osshp.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ids: ["abc"] }),
    }),
  );
  expect(res.status).toBe(401);
  expect(res.headers.get("cache-control")).toBe("no-store");
});
