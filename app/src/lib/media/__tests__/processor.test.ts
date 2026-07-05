// Unit tests for the M2.7 image processing service.
//
// Privacy-floor gate: a GPS-tagged input must produce variants with no residual
// EXIF/GPS data (the privacy floor for travel-photo uploads).
//
// The GPS-tagged fixture is generated at test time using sharp + a manually
// constructed minimal EXIF APP1 block. GPS coordinates are 0°N 0°E — the
// null-island point, chosen deliberately as synthetic / non-real-location data.

import { expect, test } from "bun:test";
import sharp from "sharp";
import { processImage, DEFAULT_WIDTHS } from "../processor";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Returns a small solid-colour JPEG with a synthetic GPS EXIF APP1 block
 * injected right after the SOI marker.
 *
 * The GPS data is 0°0'0" N 0°0'0" E — the null island, a conventional
 * placeholder with no connection to any real place. No real location is
 * stored or used in this fixture.
 */
async function createGpsTaggedJpeg(
  width = 20,
  height = 20,
): Promise<Buffer> {
  // Build a minimal JPEG base (sharp strips all metadata by default, so the
  // base is EXIF-free — we'll inject our own synthetic block below).
  const base = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .jpeg()
    .toBuffer();

  // Minimal EXIF APP1 block (102 bytes total).
  //
  // Structure (all TIFF fields in little-endian byte order):
  //   APP1 marker  FF E1
  //   Length       00 64  (100 — counts the length field + "Exif\0\0" + 92 bytes of TIFF)
  //   Exif header  45 78 69 66 00 00  ("Exif\0\0")
  //   TIFF header  II (4949) + magic (2A00) + IFD0 offset (08000000)
  //   IFD0         1 entry: GPS SubIFD pointer → offset 26
  //   GPS IFD      3 entries: GPSVersionID + GPSLatitudeRef + GPSLatitude
  //   Rationals    0°0'0" N  (0/1 degrees, 0/1 minutes, 0/1 seconds)
  const exifApp1 = Buffer.from([
    // ── APP1 marker + length ──
    0xff, 0xe1,       // APP1 marker
    0x00, 0x64,       // Length = 100 (0x64)

    // ── Exif identifier ──
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,  // "Exif\0\0"

    // ── TIFF header (little-endian) ──
    0x49, 0x49,       // "II" — little-endian byte order
    0x2a, 0x00,       // TIFF magic = 42
    0x08, 0x00, 0x00, 0x00,  // Offset to IFD0 = 8

    // ── IFD0 (at TIFF offset 8, 18 bytes) ──
    0x01, 0x00,       // 1 directory entry
    // Entry: GPS SubIFD pointer (tag 0x8825, type LONG, count 1, value = GPS IFD offset = 26)
    0x25, 0x88,       // tag 0x8825
    0x04, 0x00,       // type LONG (4)
    0x01, 0x00, 0x00, 0x00,  // count = 1
    0x1a, 0x00, 0x00, 0x00,  // value = 26 = 0x1A (TIFF offset of GPS IFD)
    0x00, 0x00, 0x00, 0x00,  // next IFD offset = 0 (no more IFDs)

    // ── GPS IFD (at TIFF offset 26, 42 bytes) ──
    0x03, 0x00,       // 3 directory entries

    // Entry 0: GPSVersionID (tag 0x0000, type BYTE, count 4, inline value [2,3,0,0])
    0x00, 0x00,       // tag 0x0000
    0x01, 0x00,       // type BYTE (1)
    0x04, 0x00, 0x00, 0x00,  // count = 4
    0x02, 0x03, 0x00, 0x00,  // value [2, 3, 0, 0] inline

    // Entry 1: GPSLatitudeRef (tag 0x0001, type ASCII, count 2, inline "N\0")
    0x01, 0x00,       // tag 0x0001
    0x02, 0x00,       // type ASCII (2)
    0x02, 0x00, 0x00, 0x00,  // count = 2
    0x4e, 0x00, 0x00, 0x00,  // "N\0" inline (North)

    // Entry 2: GPSLatitude (tag 0x0002, type RATIONAL, count 3, value at TIFF offset 68)
    0x02, 0x00,       // tag 0x0002
    0x05, 0x00,       // type RATIONAL (5)
    0x03, 0x00, 0x00, 0x00,  // count = 3
    0x44, 0x00, 0x00, 0x00,  // offset = 68 = 0x44

    // GPS IFD next pointer = 0
    0x00, 0x00, 0x00, 0x00,

    // ── Rational data (at TIFF offset 68, 24 bytes) ──
    // Each RATIONAL = 4-byte numerator + 4-byte denominator (LE).
    // 0°0'0" N — synthetic null-island coordinates, not a real location.
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,  // degrees  0/1
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,  // minutes  0/1
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,  // seconds  0/1
  ]);

  // Splice the APP1 block in right after the SOI marker (first 2 bytes = FF D8).
  return Buffer.concat([base.subarray(0, 2), exifApp1, base.subarray(2)]);
}

// ---------------------------------------------------------------------------
// GPS strip
// ---------------------------------------------------------------------------

test("GPS EXIF is stripped from output by default (privacy floor)", async () => {
  const gpsJpeg = await createGpsTaggedJpeg(20, 20);

  // Pre-condition: the fixture must actually carry EXIF data.
  const inputMeta = await sharp(gpsJpeg).metadata();
  expect(inputMeta.exif).toBeDefined();

  // Process at the source width so there is exactly one variant.
  const [variant] = await processImage(gpsJpeg, { widths: [20] });

  // Post-condition: no EXIF in the output (GPS strip verified).
  const outputMeta = await sharp(variant.buffer).metadata();
  expect(outputMeta.exif).toBeUndefined();

  // Dimensions and type must be correct.
  expect(variant.width).toBe(20);
  expect(variant.height).toBe(20);
  expect(variant.mimeType).toBe("image/jpeg");
});

test("GPS EXIF is stripped across all responsive variants", async () => {
  // 40×30 source → request widths [20, 40]; both should have no EXIF.
  const gpsJpeg = await createGpsTaggedJpeg(40, 30);

  const variants = await processImage(gpsJpeg, { widths: [20, 40] });

  expect(variants).toHaveLength(2);
  for (const variant of variants) {
    const meta = await sharp(variant.buffer).metadata();
    expect(meta.exif).toBeUndefined();
  }

  // Variant dimensions must match the requested widths.
  expect(variants[0].width).toBe(20);
  expect(variants[0].height).toBe(15);  // 30 * (20/40) = 15
  expect(variants[1].width).toBe(40);
  expect(variants[1].height).toBe(30);
});

// ---------------------------------------------------------------------------
// EXIF preservation opt-in
// ---------------------------------------------------------------------------

test("EXIF is preserved when stripExif is explicitly false", async () => {
  const gpsJpeg = await createGpsTaggedJpeg(20, 20);

  const [variant] = await processImage(gpsJpeg, {
    widths: [20],
    stripExif: false,
  });

  // With opt-in preservation the output should still carry EXIF.
  const meta = await sharp(variant.buffer).metadata();
  expect(meta.exif).toBeDefined();
});

// ---------------------------------------------------------------------------
// Responsive sizing
// ---------------------------------------------------------------------------

test("generates correct responsive variants from a large source", async () => {
  // 1200×900 source → request [400, 800]; both widths are within the source.
  const largeJpeg = await sharp({
    create: {
      width: 1200,
      height: 900,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .jpeg()
    .toBuffer();

  const variants = await processImage(largeJpeg, { widths: [400, 800] });

  expect(variants).toHaveLength(2);
  expect(variants[0].width).toBe(400);
  expect(variants[0].height).toBe(300);  // 900 * (400/1200)
  expect(variants[1].width).toBe(800);
  expect(variants[1].height).toBe(600);  // 900 * (800/1200)
});

test("no upscaling — all targets wider than source collapse to one source-width variant", async () => {
  const smallJpeg = await sharp({
    create: {
      width: 50,
      height: 50,
      channels: 3,
      background: { r: 200, g: 200, b: 200 },
    },
  })
    .jpeg()
    .toBuffer();

  // All requested widths exceed the 50px source.
  const variants = await processImage(smallJpeg, { widths: [100, 200, 400] });

  // Must produce exactly one variant at the native source width.
  expect(variants).toHaveLength(1);
  expect(variants[0].width).toBe(50);
  expect(variants[0].height).toBe(50);
});

test("partial no-upscaling — widths beyond source are silently skipped", async () => {
  const jpeg = await sharp({
    create: {
      width: 600,
      height: 400,
      channels: 3,
      background: { r: 100, g: 100, b: 100 },
    },
  })
    .jpeg()
    .toBuffer();

  // Request [400, 800]; 800 exceeds the 600px source and must be skipped.
  const variants = await processImage(jpeg, { widths: [400, 800] });

  expect(variants).toHaveLength(1);
  expect(variants[0].width).toBe(400);
});

// ---------------------------------------------------------------------------
// EXIF orientation auto-correct (issue 055)
// ---------------------------------------------------------------------------
//
// A phone photo shot in portrait is stored with LANDSCAPE pixels plus an EXIF
// Orientation tag telling the viewer to rotate 90°. Stripping EXIF without first
// applying the rotation left the pixels sideways with no signal to correct them —
// so the photo rendered rotated. These tests build a wide (landscape) source,
// tag it Orientation 6 (rotate 90° CW) / 8 (rotate 90° CCW), and assert the
// processed output is physically UPRIGHT (portrait: height > width) — which is
// only possible if .rotate() ran before the strip. The privacy floor (no EXIF in
// output) must still hold.

/** A wide landscape JPEG carrying the given EXIF Orientation tag (pixels NOT
 *  pre-rotated — the tag is the only rotation signal, exactly like a phone). */
async function createOrientedJpeg(orientation: number): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 50, channels: 3, background: { r: 90, g: 140, b: 200 } },
  })
    .withMetadata({ orientation })
    .jpeg()
    .toBuffer();
}

test("Orientation 6 (rotate 90° CW) is baked upright in the output pixels", async () => {
  const src = await createOrientedJpeg(6);
  // Pre-condition: the fixture really carries orientation 6 with wide pixels.
  const inMeta = await sharp(src).metadata();
  expect(inMeta.orientation).toBe(6);
  expect(inMeta.width).toBe(100);
  expect(inMeta.height).toBe(50);

  const [variant] = await processImage(src, { widths: [9999] }); // no downscale

  // Post-condition: physically upright — a 100×50 landscape rotated 90° is a
  // 50×100 portrait. Without the .rotate() fix this stays 100×50 (the bug).
  expect(variant.height).toBeGreaterThan(variant.width);
  expect(variant.width).toBe(50);
  expect(variant.height).toBe(100);

  // The orientation tag is normalised away (privacy floor + no double-rotate).
  const outMeta = await sharp(variant.buffer).metadata();
  expect(outMeta.exif).toBeUndefined();
  expect(outMeta.orientation ?? 1).toBe(1);
});

test("Orientation 8 (rotate 90° CCW) is baked upright in the output pixels", async () => {
  const src = await createOrientedJpeg(8);
  expect((await sharp(src).metadata()).orientation).toBe(8);

  const [variant] = await processImage(src, { widths: [9999] });

  expect(variant.height).toBeGreaterThan(variant.width);
  expect(variant.width).toBe(50);
  expect(variant.height).toBe(100);
});

test("responsive widths compare against the UPRIGHT width, not the stored sensor width", async () => {
  // 100×50 landscape tagged Orientation 6 → upright is 50×100 (portrait, width 50).
  // Requesting width 80 must be skipped as an upscale of the 50px-wide upright
  // image; the single delivered variant is the native upright width (50).
  const src = await createOrientedJpeg(6);
  const variants = await processImage(src, { widths: [80] });
  expect(variants).toHaveLength(1);
  expect(variants[0].width).toBe(50);
  expect(variants[0].height).toBe(100);
});

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

test("WebP output format is produced when requested", async () => {
  const jpeg = await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .jpeg()
    .toBuffer();

  const [variant] = await processImage(jpeg, { widths: [50], format: "webp" });

  expect(variant.mimeType).toBe("image/webp");
  expect(variant.width).toBe(50);
  // Confirm it is actually a WebP buffer (starts with RIFF...WEBP).
  expect(variant.buffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(variant.buffer.subarray(8, 12).toString("ascii")).toBe("WEBP");
});

// ---------------------------------------------------------------------------
// DEFAULT_WIDTHS exported constant
// ---------------------------------------------------------------------------

test("un-oriented images are unaffected by auto-orient (rotate is a no-op)", async () => {
  // Regression guard: adding .rotate() must NOT alter an image with no orientation
  // tag. A 60×40 landscape stays 60×40.
  const plain = await sharp({
    create: { width: 60, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();
  const [variant] = await processImage(plain, { widths: [60] });
  expect(variant.width).toBe(60);
  expect(variant.height).toBe(40);
});

test("DEFAULT_WIDTHS are [400, 800, 1600]", () => {
  expect([...DEFAULT_WIDTHS]).toEqual([400, 800, 1600]);
});
