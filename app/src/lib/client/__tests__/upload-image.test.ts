// buildImageMarkdown (issue 037 §3.4) — the string the picker inserts into the
// code-block body at the cursor. It renders in the Preview pane through the
// existing pipeline (no new render code). Blank-line wrapping lands it as its own
// block in the raw-Markdown source. Fails on pre-change code (helper is new).

import { expect, test } from "bun:test";
import { buildImageMarkdown, uploadImage, MAX_UPLOAD_BYTES } from "../upload-image";

test("builds a block-level Markdown image with the captured alt + url", () => {
  const md = buildImageMarkdown("a red boat", "/media/abc123/800.jpg");
  expect(md).toBe("\n![a red boat](/media/abc123/800.jpg)\n");
  // The core invariant: the exact ![alt](/media/<key>) syntax.
  expect(md).toContain("![a red boat](/media/abc123/800.jpg)");
});

test("empty alt yields valid (decorative) Markdown image syntax", () => {
  expect(buildImageMarkdown("", "/media/xyz/400.jpg")).toBe(
    "\n![](/media/xyz/400.jpg)\n",
  );
});

// Pre-flight size guard (issue 049): an oversize file is rejected with a clear,
// friendly message BEFORE any bytes are uploaded — not after a long, failed POST.
test("uploadImage rejects an oversize file with a friendly message", async () => {
  const oversize = {
    size: MAX_UPLOAD_BYTES + 1,
    name: "huge.png",
    type: "image/png",
  } as unknown as File;

  await expect(uploadImage(oversize, "alt")).rejects.toThrow(
    /maximum is 25 MB/,
  );
});

test("MAX_UPLOAD_BYTES matches the route ceiling (25 MB)", () => {
  expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
});
