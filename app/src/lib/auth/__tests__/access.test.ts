// Default-deny access logic + path normalization + principal-header strip.

import { expect, test } from "bun:test";
import {
  decideAccess,
  isPublicPath,
  normalizePath,
  PRINCIPAL_HEADERS,
  stripPrincipalHeaders,
} from "../access";

test("normalizePath defeats the classic path-normalization bypass set", () => {
  expect(normalizePath("/Admin")).toBe("/admin"); // case
  expect(normalizePath("/admin/")).toBe("/admin"); // trailing slash
  expect(normalizePath("//admin")).toBe("/admin"); // double slash
  expect(normalizePath("/admin%2Fposts")).toBe("/admin/posts"); // %2F decode
  expect(normalizePath("/admin.")).toBe("/admin"); // trailing dot
  expect(normalizePath("/admin;foo=bar")).toBe("/admin"); // matrix param
  expect(normalizePath("/admin?x=1")).toBe("/admin"); // query stripped
  // ".." is resolved as path navigation (not eaten), so traversal cannot
  // masquerade as a public prefix.
  expect(normalizePath("/ADMIN%2F..%2Fsecret")).toBe("/secret");
  expect(normalizePath("/posts/../admin")).toBe("/admin");
  expect(normalizePath("/")).toBe("/");
});

test("traversal cannot smuggle a protected path under a public prefix", () => {
  // /posts/ is public, but /posts/../admin really targets /admin → must deny.
  expect(decideAccess("/posts/../admin")).toBe("protected");
  expect(decideAccess("/posts/%2e%2e/admin")).toBe("protected");
});

test("deny-by-default: an unknown route is protected", () => {
  // The load-bearing H1 property: a route nobody allowlisted is private.
  expect(decideAccess("/admin")).toBe("protected");
  expect(decideAccess("/admin/posts")).toBe("protected");
  expect(decideAccess("/api/admin/anything")).toBe("protected");
  expect(decideAccess("/api/secret-new-route")).toBe("protected");
  expect(decideAccess("/totally/unknown")).toBe("protected");
});

test("normalization bypass attempts are still denied", () => {
  // A path that tries to look public via case/encoding must not slip the deny.
  expect(decideAccess("/Admin")).toBe("protected");
  expect(decideAccess("/api/ADMIN/x")).toBe("protected");
  expect(decideAccess("/admin%2e")).toBe("protected"); // %2e => '.' => stripped => /admin
});

test("explicit allowlist entries are public", () => {
  expect(decideAccess("/")).toBe("public");
  expect(decideAccess("/api/health")).toBe("public");
  expect(decideAccess("/api/auth/login/options")).toBe("public");
  expect(decideAccess("/favicon.ico")).toBe("public");
  expect(decideAccess("/_next/static/chunk.js")).toBe("public");
  expect(decideAccess("/posts/hello-world")).toBe("public");
  expect(isPublicPath("/api/auth/")).toBe(true);
});

test("M1.8 public surfaces are allowlisted; admin authoring stays protected", () => {
  // First-run + login + the public theme-rendered Blog must be reachable
  // unauthenticated.
  // /setup stays on PUBLIC_EXACT (bootstrap requirement — see security note in
  // access.ts); post-config 404 is enforced by the page-level guard instead.
  expect(decideAccess("/setup")).toBe("public");
  expect(decideAccess("/login")).toBe("public");
  // Recovery/fallback login pages — unauthenticated operator must reach these.
  expect(decideAccess("/login/recovery")).toBe("public");
  expect(decideAccess("/blog")).toBe("public");
  expect(decideAccess("/blog/hello-world")).toBe("public");
  expect(decideAccess("/tags/news")).toBe("public");
  // App-owned + theme static stylesheets the theme documents link to.
  expect(decideAccess("/structural.css")).toBe("public");
  expect(decideAccess("/shiki.css")).toBe("public"); // Shiki highlight CSS (V-013)
  expect(decideAccess("/themes/skeleton/theme.css")).toBe("public");
  // Admin authoring + its APIs are NOT public — default-deny holds.
  expect(decideAccess("/admin")).toBe("protected");
  expect(decideAccess("/admin/blog")).toBe("protected");
  expect(decideAccess("/admin/blog/new")).toBe("protected");
  expect(decideAccess("/api/admin/blog/posts")).toBe("protected");
  expect(decideAccess("/api/setup")).toBe("protected");
});

test("stripPrincipalHeaders removes every spoofable identity header (H3)", () => {
  const headers = new Headers({
    "x-osshp-principal": "admin",
    "x-authenticated-user": "attacker",
    "x-forwarded-user": "root",
    "content-type": "application/json",
  });
  const cleaned = stripPrincipalHeaders(headers);
  for (const name of PRINCIPAL_HEADERS) {
    expect(cleaned.get(name)).toBeNull();
  }
  // Non-principal headers survive.
  expect(cleaned.get("content-type")).toBe("application/json");
  // Original is not mutated.
  expect(headers.get("x-osshp-principal")).toBe("admin");
});
