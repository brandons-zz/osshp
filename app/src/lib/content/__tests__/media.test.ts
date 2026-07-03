import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createMedia, getMediaByKey, listMedia } from "../media";

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("round-trips a media reference with responsive sizes (modeled fields)", async () => {
  const created = await createMedia(db, {
    storageKey: "uploads/photo.jpg",
    alt: "a photo",
    mimeType: "image/jpeg",
    width: 4000,
    height: 3000,
    responsiveSizes: [
      { width: 800, height: 600, key: "uploads/photo_800.jpg" },
      { width: 1600, height: 1200, key: "uploads/photo_1600.jpg" },
    ],
    exifStripped: true,
  });

  const fetched = await getMediaByKey(db, "uploads/photo.jpg");
  expect(fetched!.id).toBe(created.id);
  expect(fetched!.alt).toBe("a photo");
  expect(fetched!.responsiveSizes).toEqual([
    { width: 800, height: 600, key: "uploads/photo_800.jpg" },
    { width: 1600, height: 1200, key: "uploads/photo_1600.jpg" },
  ]);
  expect(fetched!.exifStripped).toBe(true);
});

test("media defaults: empty responsive sizes and exifStripped false until M2 pipeline runs", async () => {
  await createMedia(db, { storageKey: "uploads/raw.jpg" });
  const fetched = await getMediaByKey(db, "uploads/raw.jpg");
  expect(fetched!.responsiveSizes).toEqual([]);
  expect(fetched!.exifStripped).toBe(false);
  expect((await listMedia(db)).length).toBe(1);
});

test("storage_key is unique", async () => {
  await createMedia(db, { storageKey: "dup.jpg" });
  await expect(createMedia(db, { storageKey: "dup.jpg" })).rejects.toThrow();
});
