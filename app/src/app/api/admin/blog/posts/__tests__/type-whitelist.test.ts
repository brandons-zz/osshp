// Issue 071 (Finding 1) — the blog create/edit routes must not accept a
// client-controlled `type` field. Before this fix, `POST /api/admin/blog/posts`
// wrote `type: body.type ?? "article"` and `PATCH /api/admin/blog/posts/[id]`
// wrote `type: body.type` straight through — a raw request with
// `{"type":"photo-post", ...}` could create or convert a row to
// `type='photo-post'` while only the Blog module's own gate
// (requireModuleEnabled) was checked; the Photos module's disabled state (and
// its content-type shape/validation) was never consulted.
//
// These routes call the production `getDb()` singleton (real postgres.js), not
// the PGlite test seam, so a full request/response exercise isn't hermetic —
// this codebase's established convention for that constraint (see
// recovery-login-routes.test.ts "non-enumeration" test) is a static source
// assertion: the route source must not read `body.type` at all, and the write
// call must hardcode the owned type literally. A regression that reintroduces
// `body.type` (or an optional `type` field on the request body interface)
// fails this test immediately, independent of any DB.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const postsDir = join(import.meta.dir, "..");

test("blog create route (POST) never reads a client-supplied type — always writes 'article'", () => {
  const src = readFileSync(join(postsDir, "route.ts"), "utf8");
  expect(src).not.toContain("body.type");
  expect(src).not.toMatch(/type\?:\s*PostType/);
  expect(src).toMatch(/type:\s*"article"/);
});

test("blog edit route (PATCH [id]) never reads a client-supplied type — always writes 'article'", () => {
  const src = readFileSync(join(postsDir, "[id]/route.ts"), "utf8");
  expect(src).not.toContain("body.type");
  expect(src).not.toMatch(/type\?:\s*PostType/);
  expect(src).toMatch(/type:\s*"article"/);
});
