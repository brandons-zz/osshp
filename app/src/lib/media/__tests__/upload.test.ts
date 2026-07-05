// Intent tests for the M2.9 media upload pipeline (storeUploadedImage).
//
// The two business rules these encode:
//   1. PRIVACY FLOOR — a GPS/EXIF-tagged upload comes out of the pipeline with all
//      metadata stripped from EVERY stored variant (design §8). A regression that
//      stored the raw upload, or skipped the strip, would leak a travel photo's
//      location.
//   2. LINKED REFERENCE — the upload produces responsive variants in the store and
//      a single media-table reference (linked to content by its /media/<key> URL).
//
// Storage is an in-memory MediaStorage so the pipeline is verified end-to-end with
// no live Garage; the DB is PGlite (real PostgreSQL) per the repo test convention.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import sharp from "sharp";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { getMediaByKey } from "@/lib/content/media";
import { storeUploadedImage } from "../upload";
import type { MediaStorage, StoredObject } from "../storage";

// In-memory storage seam — captures every put so we can read the stored bytes back
// and prove the EXIF/GPS strip happened on what actually landed in the store.
class MemoryStorage implements MediaStorage {
  readonly objects = new Map<string, { buffer: Buffer; contentType: string }>();
  async ensureBucket(): Promise<void> {}
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { buffer: body, contentType });
  }
  async get(key: string): Promise<StoredObject> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`no object: ${key}`);
    return {
      stream: Readable.from(o.buffer),
      contentType: o.contentType,
      size: o.buffer.length,
    };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

// A real JPEG carrying a synthetic GPS EXIF APP1 block (0°0'0" N — null island,
// no real location). Same fixture construction the M2.7 processor test uses, so
// the privacy assertion is faithful to a genuine GPS-tagged upload.
async function gpsTaggedJpeg(width = 1600, height = 1000): Promise<Buffer> {
  const base = await sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 120, b: 60 } },
  })
    .jpeg()
    .toBuffer();

  // Minimal EXIF APP1 with a GPS IFD (latitude ref + 0/0/0 coordinates).
  const exifApp1 = Buffer.from([
    0xff, 0xe1, 0x00, 0x64, // APP1 marker + length 100
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF header (LE), IFD0 @8
    0x01, 0x00, // IFD0: 1 entry
    0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00, // GPS IFD ptr → 26
    0x00, 0x00, 0x00, 0x00, // next IFD = 0
    0x03, 0x00, // GPS IFD: 3 entries
    0x00, 0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x02, 0x03, 0x00, 0x00, // GPSVersionID
    0x01, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x4e, 0x00, 0x00, 0x00, // GPSLatitudeRef "N"
    0x02, 0x00, 0x05, 0x00, 0x03, 0x00, 0x00, 0x00, 0x44, 0x00, 0x00, 0x00, // GPSLatitude @68
    0x00, 0x00, 0x00, 0x00, // GPS IFD next = 0
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, // 0/1 degrees
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, // 0/1 minutes
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, // 0/1 seconds
  ]);
  // Splice the APP1 block in right after the SOI marker (FF D8).
  return Buffer.concat([base.subarray(0, 2), exifApp1, base.subarray(2)]);
}

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("fixture sanity: the source upload really carries EXIF", async () => {
  const tagged = await gpsTaggedJpeg();
  const meta = await sharp(tagged).metadata();
  expect(meta.exif).toBeDefined(); // if this fails the strip assertion is vacuous
});

test("upload yields responsive variants with EXIF/GPS stripped by default", async () => {
  const storage = new MemoryStorage();
  const tagged = await gpsTaggedJpeg(1600, 1000);

  const { media, url } = await storeUploadedImage(db, storage, {
    buffer: tagged,
    alt: "a tagged photo",
  });

  // Responsive variants: source is 1600px wide so all default widths apply.
  expect(media.responsiveSizes.length).toBe(3);
  expect(media.responsiveSizes.map((s) => s.width).sort((a, b) => a - b)).toEqual([
    400, 800, 1600,
  ]);
  expect(media.exifStripped).toBe(true);

  // Every stored variant must be EXIF/GPS-free — the privacy guarantee.
  expect(storage.objects.size).toBe(3);
  for (const { buffer } of storage.objects.values()) {
    const meta = await sharp(buffer).metadata();
    expect(meta.exif).toBeUndefined();
  }
});

test("creates a single media reference linked by its /media/<key> URL", async () => {
  const storage = new MemoryStorage();
  const { media, url } = await storeUploadedImage(db, storage, {
    buffer: await gpsTaggedJpeg(1600, 1000),
    alt: "linked photo",
  });

  // The reference is persisted and resolvable by its storage key (the link).
  const fetched = await getMediaByKey(db, media.storageKey);
  expect(fetched).not.toBeNull();
  expect(fetched!.alt).toBe("linked photo");
  expect(fetched!.exifStripped).toBe(true);

  // The public URL points at the primary (largest) variant that was stored.
  expect(url).toBe(`/media/${media.storageKey}`);
  expect(storage.objects.has(media.storageKey)).toBe(true);
  expect(media.width).toBe(1600);
});

test("no-upscale: a small source still produces one stored, stripped variant", async () => {
  const storage = new MemoryStorage();
  const { media } = await storeUploadedImage(db, storage, {
    buffer: await gpsTaggedJpeg(200, 150), // below every default width
    alt: "small",
  });
  expect(media.responsiveSizes.length).toBe(1);
  expect(media.responsiveSizes[0].width).toBe(200);
  const stored = storage.objects.get(media.storageKey)!;
  expect((await sharp(stored.buffer).metadata()).exif).toBeUndefined();
});
