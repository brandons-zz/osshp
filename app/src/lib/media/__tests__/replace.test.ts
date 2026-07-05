// Replace pipeline (issue 037 §1.5 / §7) — replaceUploadedImage rewrites a media
// binary IN PLACE, keeping the same id, storing new EXIF/GPS-stripped variants
// and pruning the old variant objects the new upload does not reproduce.
//
// Fails on pre-change code (replaceUploadedImage + MediaStorage.delete did not
// exist). The DB is PGlite; storage is an in-memory seam that RECORDS deletes so
// the prune assertion is faithful.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import sharp from "sharp";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { getMediaById } from "@/lib/content/media";
import { storeUploadedImage, replaceUploadedImage } from "../upload";
import type { MediaStorage, StoredObject } from "../storage";

class MemoryStorage implements MediaStorage {
  readonly objects = new Map<string, { buffer: Buffer; contentType: string }>();
  readonly deleted: string[] = [];
  async ensureBucket(): Promise<void> {}
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { buffer: body, contentType });
  }
  async get(key: string): Promise<StoredObject> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`no object: ${key}`);
    return { stream: Readable.from(o.buffer), contentType: o.contentType, size: o.buffer.length };
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 80, b: 120 } },
  })
    .jpeg()
    .toBuffer();
}

let h: TestDb;
let db: Db;
let storage: MemoryStorage;
beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
  storage = new MemoryStorage();
});
afterEach(() => h.close());

test("replace keeps the id, swaps variants, prunes stale old objects, keeps alt", async () => {
  // Original: a wide image → 400/800/1600 variants.
  const original = await storeUploadedImage(db, storage, {
    buffer: await jpeg(1600, 1200),
    alt: "original description",
  });
  const id = original.media.id;
  // The content anchor is the STORAGE PREFIX (what the URL carries), distinct
  // from media.id. Replace must keep this prefix stable so references stay valid.
  const prefix = original.media.storageKey.split("/")[0];
  expect(prefix).not.toBe(id); // id ≠ storage prefix in this schema
  expect(
    original.media.responsiveSizes.map((s) => s.width).sort((a, b) => a - b),
  ).toEqual([400, 800, 1600]);

  // Replace with a NARROW image → only a 400 variant. The primary filename
  // changes (1600.jpg → 400.jpg), which is exactly the case a byte-swap breaks.
  const replaced = await replaceUploadedImage(db, storage, id, {
    buffer: await jpeg(500, 375),
  });
  expect(replaced).not.toBeNull();
  expect(replaced!.media.id).toBe(id); // same row id
  // Same prefix preserved; only the primary filename changes.
  expect(replaced!.oldPrimaryUrl).toBe(`/media/${prefix}/1600.jpg`);
  expect(replaced!.url).toBe(`/media/${prefix}/400.jpg`);
  // oldUrls carries EVERY old variant URL so a body embedding a non-primary
  // variant is re-pointed too (issue 039).
  expect(replaced!.oldUrls.sort()).toEqual(
    [
      `/media/${prefix}/1600.jpg`,
      `/media/${prefix}/400.jpg`,
      `/media/${prefix}/800.jpg`,
    ].sort(),
  );
  expect(replaced!.media.alt).toBe("original description"); // alt preserved

  // The row is rewritten in place.
  const row = await getMediaById(db, id);
  expect(row!.storageKey).toBe(`${prefix}/400.jpg`);
  expect(row!.responsiveSizes.map((s) => s.width)).toEqual([400]);

  // Stale old objects (800 + 1600) are pruned; the reused 400 key is NOT deleted.
  expect(storage.deleted.sort()).toEqual([
    `${prefix}/1600.jpg`,
    `${prefix}/800.jpg`,
  ]);
  expect(storage.objects.has(`${prefix}/400.jpg`)).toBe(true);
  expect(storage.objects.has(`${prefix}/1600.jpg`)).toBe(false);
});

test("replace of a missing id returns null", async () => {
  const res = await replaceUploadedImage(
    db,
    storage,
    "00000000-0000-0000-0000-000000000000",
    { buffer: await jpeg(400, 300) },
  );
  expect(res).toBeNull();
});
