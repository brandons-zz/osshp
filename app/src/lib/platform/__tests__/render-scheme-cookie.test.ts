// readSchemeCookie (issue 076) — a malformed, unsigned, client-writable
// `osshp-scheme` cookie must fall back to "no override" (null), never throw.
// Regression for the unhandled URIError that 500'd every theme-rendered public
// route (renderPublicRoute is the single choke point for /, /blog, /photos,
// /pages, /tags, and their slug variants — all of them call readSchemeCookie).

import { expect, test } from "bun:test";
import { readSchemeCookie } from "../render";

function reqWithCookie(cookieHeader: string): Request {
  return new Request("https://example.test/", {
    headers: { cookie: cookieHeader },
  });
}

test("malformed percent-encoding does not throw — falls back to null (default scheme)", () => {
  // A lone "%" is invalid percent-encoding; decodeURIComponent throws a
  // URIError on it. Before the fix this call was unguarded.
  expect(() => readSchemeCookie(reqWithCookie("osshp-scheme=%"))).not.toThrow();
  expect(readSchemeCookie(reqWithCookie("osshp-scheme=%"))).toBeNull();
});

test("another malformed encoding (%zz) also falls back to null, not throw", () => {
  expect(() => readSchemeCookie(reqWithCookie("osshp-scheme=%zz"))).not.toThrow();
  expect(readSchemeCookie(reqWithCookie("osshp-scheme=%zz"))).toBeNull();
});

test("a malformed osshp-scheme cookie alongside other valid cookies still resolves to null, not throw", () => {
  expect(
    readSchemeCookie(reqWithCookie("foo=bar; osshp-scheme=%; baz=qux")),
  ).toBeNull();
});

test("valid 'dark' cookie value is returned unchanged", () => {
  expect(readSchemeCookie(reqWithCookie("osshp-scheme=dark"))).toBe("dark");
});

test("valid 'light' cookie value is returned unchanged", () => {
  expect(readSchemeCookie(reqWithCookie("osshp-scheme=light"))).toBe("light");
});

test("no cookie header at all returns null", () => {
  expect(readSchemeCookie(new Request("https://example.test/"))).toBeNull();
});

test("no osshp-scheme cookie present (other cookies only) returns null", () => {
  expect(readSchemeCookie(reqWithCookie("foo=bar; baz=qux"))).toBeNull();
});
