// End-to-end pipeline tests for HEIC + large-photo uploads (issues 048/049).
//
//   - A real HEIC upload flows all the way through storeUploadedImage: it is
//     transcoded to JPEG, produces responsive variants, and lands EXIF-free in
//     the store (privacy floor) with a jpeg mime on the media row.
//   - A large, iPhone-resolution photo produces the full variant set — the
//     realistic-size happy path that tiny fixtures never exercised (why 049 and
//     friends slipped: the pipeline was only ever tested on 20px fixtures).
//
// DB is PGlite (real Postgres) per repo convention; storage is in-memory so we
// can read back the exact stored bytes and assert the strip.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { storeUploadedImage } from "../upload";
import type { MediaStorage, StoredObject } from "../storage";

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

const HEIC = readFileSync(join(import.meta.dir, "fixtures", "sample.heic"));

let h: TestDb;
let db: Db;
beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("a HEIC upload transcodes to JPEG variants, stored EXIF-free (048)", async () => {
  const storage = new MemoryStorage();
  const { media, url } = await storeUploadedImage(db, storage, {
    buffer: HEIC,
    alt: "an iphone photo",
    filename: "IMG_0421.HEIC",
  });

  // Produced responsive variants and a jpeg mime (transcoded, not HEIC).
  expect(media.responsiveSizes.length).toBeGreaterThan(0);
  expect(media.mimeType).toBe("image/jpeg");
  expect(url).toBe(`/media/${media.storageKey}`);

  // Every stored object is a decodable JPEG with no EXIF/GPS.
  expect(storage.objects.size).toBe(media.responsiveSizes.length);
  for (const { buffer } of storage.objects.values()) {
    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
  }
});

test("a large iPhone-resolution photo produces the full variant set (049)", async () => {
  const storage = new MemoryStorage();
  // 4032x3024 — a real iPhone 12MP frame; exercises genuine downscale work, not
  // a 20px toy. High-entropy noise so the encoded bytes are non-trivial in size.
  const noise = Buffer.alloc(4032 * 3024 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) & 0xff;
  const bigJpeg = await sharp(noise, {
    raw: { width: 4032, height: 3024, channels: 3 },
  })
    .jpeg()
    .toBuffer();

  const { media } = await storeUploadedImage(db, storage, {
    buffer: bigJpeg,
    alt: "a big photo",
    filename: "big.jpg",
  });

  // Source is wider than every default width, so all three variants apply.
  expect(media.responsiveSizes.map((s) => s.width).sort((a, b) => a - b)).toEqual([
    400, 800, 1600,
  ]);
  expect(media.exifStripped).toBe(true);
});
