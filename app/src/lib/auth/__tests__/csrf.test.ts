// Same-origin CSRF guard (gap-assessment A3): cross-site mutating requests are
// rejected; same-origin requests pass and get no-store; safe methods pass through.

process.env.OSSHP_ORIGIN = "https://blog.example.com";

import { expect, test } from "bun:test";
import {
  guardMutation,
  isMutatingMethod,
  isSameOrigin,
  withNoStore,
} from "../csrf";

const ORIGIN = "https://blog.example.com";

function req(
  method: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://blog.example.com/api/auth/logout", {
    method,
    headers,
  });
}

test("classifies mutating vs safe methods", () => {
  for (const m of ["POST", "put", "Patch", "DELETE"]) {
    expect(isMutatingMethod(m)).toBe(true);
  }
  for (const m of ["GET", "HEAD", "OPTIONS"]) {
    expect(isMutatingMethod(m)).toBe(false);
  }
});

test("a same-origin mutating request passes the host comparison", () => {
  expect(isSameOrigin(req("POST", { origin: ORIGIN }), ORIGIN)).toBe(true);
});

test("a cross-site mutating request is rejected (the core CSRF defense)", () => {
  expect(isSameOrigin(req("POST", { origin: "https://evil.example" }), ORIGIN)).toBe(
    false,
  );
});

test("a mutating request with NO Origin/Referer fails closed", () => {
  expect(isSameOrigin(req("POST"), ORIGIN)).toBe(false);
});

test("Referer is the fallback when Origin is absent", () => {
  expect(
    isSameOrigin(req("POST", { referer: `${ORIGIN}/admin/posts` }), ORIGIN),
  ).toBe(true);
  expect(
    isSameOrigin(req("POST", { referer: "https://evil.example/x" }), ORIGIN),
  ).toBe(false);
});

test("safe methods are never blocked, even cross-site", () => {
  expect(isSameOrigin(req("GET", { origin: "https://evil.example" }), ORIGIN)).toBe(
    true,
  );
});

test("withNoStore stamps Cache-Control: no-store", () => {
  const r = withNoStore(Response.json({ ok: true }));
  expect(r.headers.get("cache-control")).toBe("no-store");
});

test("guardMutation rejects a cross-site POST with 403 + no-store, handler never runs", async () => {
  let ran = false;
  const wrapped = guardMutation(async () => {
    ran = true;
    return Response.json({ ok: true });
  });
  const res = await wrapped(req("POST", { origin: "https://evil.example" }));
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(ran).toBe(false);
  expect(await res.json()).toEqual({ error: "csrf_failed" });
});

test("guardMutation runs the handler for a same-origin POST and stamps no-store", async () => {
  const wrapped = guardMutation(async () => Response.json({ ok: true }));
  const res = await wrapped(req("POST", { origin: ORIGIN }));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ ok: true });
});
