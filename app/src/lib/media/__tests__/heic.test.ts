// Unit tests for HEIC transcode (issue 048).
//
// Proves the two properties the pipeline relies on:
//   1. A real HEIC decodes to a JPEG that sharp can read (the default sharp build
//      cannot read HEIC directly — this is exactly the gap being closed).
//   2. ensureProcessable leaves non-HEIC bytes untouched (pass-through), and the
//      transcoded JPEG carries NO EXIF (privacy floor — no location copied over).

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { transcodeHeicToJpeg, ensureProcessable } from "../heic";
import { processImage } from "../processor";

const HEIC = readFileSync(join(import.meta.dir, "fixtures", "sample.heic"));
// A HEIC whose HEIF `irot` transform rotates a 120×60 landscape 90° → it should
// display as a 60×120 portrait. iPhone HEICs carry orientation this way (irot,
// not an EXIF tag). Used to prove a rotated HEIC ends up UPRIGHT end-to-end.
const HEIC_ROTATED = readFileSync(join(import.meta.dir, "fixtures", "rotated.heic"));

describe("transcodeHeicToJpeg", () => {
  test("transcodes a real HEIC to a sharp-readable JPEG", async () => {
    // NOTE (env): whether sharp itself can decode HEIC is BUILD-dependent —
    // the macOS Homebrew sharp bundles libheif and reads HEIC, but the
    // production alpine/musl sharp build does NOT (patent-licensing default).
    // So we do not assert on sharp's HEIC capability (that flips mac vs alpine
    // and would be an environment artifact). The transcode runs unconditionally
    // (driven by a magic-byte sniff, not sharp's ability), so it is correct on
    // both. What we assert is the real property: HEIC bytes -> a valid JPEG.
    const jpeg = await transcodeHeicToJpeg(HEIC);
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });

  test("the transcoded JPEG carries no EXIF (no location copied from the HEIC)", async () => {
    const jpeg = await transcodeHeicToJpeg(HEIC);
    const meta = await sharp(jpeg).metadata();
    expect(meta.exif).toBeUndefined();
  });
});

describe("ensureProcessable", () => {
  test("transcodes HEIC input to a sharp-readable buffer", async () => {
    const out = await ensureProcessable(HEIC, "photo.heic");
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
  });

  test("passes a normal JPEG through unchanged (no needless re-encode)", async () => {
    const jpeg = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    const out = await ensureProcessable(jpeg, "pic.jpg");
    expect(out).toBe(jpeg); // same buffer reference — untouched
  });
});

// ---------------------------------------------------------------------------
// HEIC orientation end-to-end (issue 055)
// ---------------------------------------------------------------------------
//
// iPhone HEICs store rotation as a HEIF `irot` transform, NOT an EXIF Orientation
// tag. heic-convert (libheif) applies that transform during decode, so the
// transcoded JPEG comes out with the pixels ALREADY upright and no orientation
// tag — the downstream processImage .rotate() is then a safe no-op. This proves
// a rotated HEIC is upright after the full upload pipeline (ensureProcessable →
// processImage), the way a sideways phone photo must not reach the gallery.
describe("HEIC orientation (issue 055)", () => {
  test("a rotated HEIC decodes to an upright (portrait) buffer", async () => {
    // The source landscape is 120×60; the irot rotates it 90° → 60×120 portrait.
    const jpeg = await transcodeHeicToJpeg(HEIC_ROTATED);
    const meta = await sharp(jpeg).metadata();
    expect(meta.height!).toBeGreaterThan(meta.width!); // upright, not sideways
  });

  test("a rotated HEIC is upright and EXIF-free through the full pipeline", async () => {
    const processable = await ensureProcessable(HEIC_ROTATED, "IMG_1234.heic");
    const [variant] = await processImage(processable, { widths: [9999] });
    // Upright: a rotated landscape becomes portrait (height > width).
    expect(variant.height).toBeGreaterThan(variant.width);
    // Privacy floor still holds — no metadata rides through.
    const outMeta = await sharp(variant.buffer).metadata();
    expect(outMeta.exif).toBeUndefined();
  });
});
