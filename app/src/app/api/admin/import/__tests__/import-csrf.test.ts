// The import route is guardMutation-wrapped: a cross-site POST is rejected
// with 403 + Cache-Control: no-store BEFORE the handler touches an uploaded
// file — same pattern as every other mutating admin route (see
// blog/__tests__/authoring-csrf.test.ts).

process.env.OSSHP_ORIGIN = "https://osshp.example.com";

import { expect, test } from "bun:test";

test("import (POST) rejects a cross-site request with 403 + no-store", async () => {
  const { POST } = (await import("../route")) as {
    POST: (r: Request) => Promise<Response>;
  };
  const req = new Request("https://osshp.example.com/api/admin/import", {
    method: "POST",
    headers: { origin: "https://evil.example.com" },
    body: new FormData(),
  });
  const res = await POST(req);
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});
