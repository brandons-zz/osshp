import { expect, test } from "bun:test";
import { isValidSlug, nextAvailableSlug, slugify } from "../slug";

test("isValidSlug accepts lowercase-alnum-hyphen only", () => {
  expect(isValidSlug("hello-world")).toBe(true);
  expect(isValidSlug("a")).toBe(true);
  expect(isValidSlug("hello world")).toBe(false);
  expect(isValidSlug("Hello-World")).toBe(false);
  expect(isValidSlug("hello--world")).toBe(false);
  expect(isValidSlug("-hello")).toBe(false);
  expect(isValidSlug("")).toBe(false);
});

test("slugify normalizes accents and punctuation", () => {
  expect(slugify("Café Déjà Vu!")).toBe("cafe-deja-vu");
  expect(slugify("  Hello   World  ")).toBe("hello-world");
  expect(slugify("Already-Slugged")).toBe("already-slugged");
  expect(slugify("!!!")).toBe("");
});

test("nextAvailableSlug returns base when free, else increments", () => {
  expect(nextAvailableSlug("foo", new Set())).toBe("foo");
  expect(nextAvailableSlug("foo", new Set(["foo"]))).toBe("foo-2");
  expect(nextAvailableSlug("foo", new Set(["foo", "foo-2", "foo-3"]))).toBe("foo-4");
});
