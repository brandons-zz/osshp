import { expect, test } from "bun:test";
import { extractMediaKeys, rewriteMediaLinks } from "@/lib/export/media-refs";
import {
  extractArchiveMediaKeys,
  rewriteArchiveMediaLinksToPublic,
  rewriteArchiveMediaSrc,
} from "../media-refs";

test("rewriteArchiveMediaLinksToPublic exactly inverts the export's rewriteMediaLinks", () => {
  const body = "See ![cover](/media/abc/800.jpg) and also ![x](/media/def/400.jpg).";
  const exported = rewriteMediaLinks(body);
  const restored = rewriteArchiveMediaLinksToPublic(exported);
  expect(restored).toBe(body);
});

test("extractArchiveMediaKeys finds every distinct archive-relative key", () => {
  const text = 'See media/abc/800.jpg and "media/def/400.jpg" and media/abc/800.jpg again.';
  expect(extractArchiveMediaKeys(text)).toEqual(["abc/800.jpg", "def/400.jpg"]);
});

test("extractArchiveMediaKeys agrees with the export side on the same key set", () => {
  const body = "![a](/media/k1/800.jpg) ![b](/media/k2/400.jpg)";
  const exportedKeys = extractMediaKeys(body);
  const exportedBody = rewriteMediaLinks(body);
  const importedKeys = extractArchiveMediaKeys(exportedBody);
  expect(importedKeys).toEqual(exportedKeys);
});

test("rewriteArchiveMediaSrc prepends a leading slash to an archive-relative src", () => {
  expect(rewriteArchiveMediaSrc("media/abc/800.jpg")).toBe("/media/abc/800.jpg");
});

test("rewriteArchiveMediaSrc leaves null and non-archive-relative values unchanged", () => {
  expect(rewriteArchiveMediaSrc(null)).toBeNull();
  expect(rewriteArchiveMediaSrc("/media/already-absolute/800.jpg")).toBe(
    "/media/already-absolute/800.jpg",
  );
  expect(rewriteArchiveMediaSrc("https://example.com/photo.jpg")).toBe(
    "https://example.com/photo.jpg",
  );
});

test("does not false-positive on prose that merely contains the substring 'media/'", () => {
  const text = "socialmedia/foo is not a reference.";
  expect(extractArchiveMediaKeys(text)).toEqual([]);
});
