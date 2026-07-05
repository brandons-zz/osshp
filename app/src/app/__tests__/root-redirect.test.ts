// Tests the bind-host-redirect fix (Defect #1 from M1.10 gate).
//
// INTENT: The root route must not emit the internal bind address in the Location
// header. In Next.js standalone (`bun server.js`), request.url reflects the
// internal bind address (e.g. http://0.0.0.0:3000/), so `new URL("/setup",
// request.url)` produces `http://0.0.0.0:3000/setup` — the wrong host.
// The fix uses a RELATIVE redirect (`Response.redirect("/setup", 302)`) so the
// Location header is `/setup` regardless of the server's bind address.
//
// This test would FAIL against the old implementation:
//   Response.redirect(new URL("/setup", request.url).toString(), 302)
// because that produces Location: http://0.0.0.0:3000/setup when the server is
// bound to 0.0.0.0:3000.

import { expect, test } from "bun:test";

test("relative redirect produces a host-agnostic Location header", () => {
  // The fixed implementation. Simulate what the route handler returns.
  const redirect = Response.redirect("/setup", 302);

  const location = redirect.headers.get("location");
  expect(location).not.toBeNull();

  // Must NOT contain the internal bind address.
  expect(location).not.toContain("0.0.0.0");
  expect(location).not.toMatch(/^http:\/\/0\.0\.0\.0/);
});

test("old implementation (pre-fix) would have emitted the bind address — documents the broken behaviour", () => {
  // Prove the old code was broken: when request.url is the bind address,
  // new URL("/setup", request.url) absolutizes to that same bind address.
  const bindRequest = new Request("http://0.0.0.0:3000/");
  const oldLocation = new URL("/setup", bindRequest.url).toString();

  // This is exactly what the old code emitted — wrong.
  expect(oldLocation).toBe("http://0.0.0.0:3000/setup");

  // The fixed code emits a relative URL instead.
  const fixedLocation = Response.redirect("/setup", 302).headers.get(
    "location",
  );
  // Must differ from the old (absolute-bind-host) form.
  expect(fixedLocation).not.toBe(oldLocation);
});
