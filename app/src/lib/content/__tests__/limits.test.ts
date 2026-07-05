// Title/slug length bounds (issue 072) — the shared validator the blog/pages/
// photos create AND update routes all call. This is the actual mechanism that
// makes "an overlong slug is rejected at create" true: every content-writing
// route imports validateTitleSlugLength and returns 400 when it is non-null.

import { expect, test } from "bun:test";
import { MAX_SLUG_BYTES, MAX_TITLE_LENGTH, validateTitleSlugLength } from "../limits";

test("a normal title/slug pair passes", () => {
  expect(validateTitleSlugLength("Hello World", "hello-world")).toBeNull();
});

test("undefined title/slug (an update route omitting the field) always passes", () => {
  expect(validateTitleSlugLength(undefined, undefined)).toBeNull();
  expect(validateTitleSlugLength(undefined, "a-slug")).toBeNull();
  expect(validateTitleSlugLength("A Title", undefined)).toBeNull();
});

test("a slug exactly at the cap passes", () => {
  const slug = "a".repeat(MAX_SLUG_BYTES);
  expect(Buffer.byteLength(slug, "utf8")).toBe(MAX_SLUG_BYTES);
  expect(validateTitleSlugLength("Title", slug)).toBeNull();
});

test("a slug one byte over the cap is rejected", () => {
  const slug = "a".repeat(MAX_SLUG_BYTES + 1);
  const err = validateTitleSlugLength("Title", slug);
  expect(err).not.toBeNull();
  expect(err).toContain("slug");
});

test("the exact overlong slug from issue 072's threat model (>97 UTF-8 bytes) is rejected", () => {
  // Reproduces the concrete repro from the issue: a slug whose "<slug>.md" USTAR
  // tail would exceed the 100-byte name field (slug > 97 bytes).
  const slug = "a".repeat(240);
  const err = validateTitleSlugLength("Title", slug);
  expect(err).not.toBeNull();
});

test("a multi-byte UTF-8 slug is bounded by BYTE length, not character count", () => {
  // Each "é" is 2 bytes in UTF-8. 45 of them is 90 bytes — under the 80-byte cap
  // by character count (45 < 80) but the byte-length check must still fire.
  const slug = "é".repeat(45);
  expect(slug.length).toBeLessThan(MAX_SLUG_BYTES);
  expect(Buffer.byteLength(slug, "utf8")).toBeGreaterThan(MAX_SLUG_BYTES);
  expect(validateTitleSlugLength("Title", slug)).not.toBeNull();
});

test("a title exactly at the cap passes; one character over is rejected", () => {
  expect(validateTitleSlugLength("t".repeat(MAX_TITLE_LENGTH), "slug")).toBeNull();
  const err = validateTitleSlugLength("t".repeat(MAX_TITLE_LENGTH + 1), "slug");
  expect(err).not.toBeNull();
  expect(err).toContain("title");
});
