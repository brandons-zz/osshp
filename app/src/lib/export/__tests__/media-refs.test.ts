import { expect, test } from "bun:test";
import { extractMediaKeys, rewriteMediaLinks } from "../media-refs";

test("extracts a key from Markdown image syntax", () => {
  const body = "See ![alt text](/media/abc-123/800.jpg) below.";
  expect(extractMediaKeys(body)).toEqual(["abc-123/800.jpg"]);
});

test("extracts a key from an HTML img src attribute", () => {
  const body = '<img src="/media/abc-123/400.webp" alt="x">';
  expect(extractMediaKeys(body)).toEqual(["abc-123/400.webp"]);
});

test("extracts a bare whitespace-terminated reference", () => {
  const body = "raw url: /media/abc-123/800.jpg end of line";
  expect(extractMediaKeys(body)).toEqual(["abc-123/800.jpg"]);
});

test("dedupes repeated references to the same key", () => {
  const body =
    "![a](/media/x/800.jpg) and again ![b](/media/x/800.jpg) and <img src=\"/media/x/800.jpg\">";
  expect(extractMediaKeys(body)).toEqual(["x/800.jpg"]);
});

test("distinguishes multiple distinct keys, preserving first-seen order", () => {
  const body = "![a](/media/one/800.jpg) then ![b](/media/two/400.webp)";
  expect(extractMediaKeys(body)).toEqual(["one/800.jpg", "two/400.webp"]);
});

test("returns an empty array when there is no /media/ reference", () => {
  expect(extractMediaKeys("just plain text, no images here")).toEqual([]);
});

test("rewriteMediaLinks drops the leading slash for every reference", () => {
  const body = "![a](/media/one/800.jpg) and ![b](/media/two/400.webp)";
  expect(rewriteMediaLinks(body)).toBe(
    "![a](media/one/800.jpg) and ![b](media/two/400.webp)",
  );
});

test("rewriteMediaLinks leaves text with no /media/ reference untouched", () => {
  const body = "Just a normal [external link](https://example.com/about) here.";
  expect(rewriteMediaLinks(body)).toBe(body);
});
