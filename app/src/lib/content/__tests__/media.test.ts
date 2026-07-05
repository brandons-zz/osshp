import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import {
  createMedia,
  getMediaByKey,
  getMediaById,
  listMedia,
  updateMediaAlt,
  updateMediaBinary,
  deleteMedia,
} from "../media";

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

// ── issue 037: alt edit / binary replace / delete ─────────────────────────────

test("updateMediaAlt trims and persists the canonical alt; list reflects it", async () => {
  const created = await createMedia(db, { storageKey: "a/1600.jpg", alt: "old" });
  const updated = await updateMediaAlt(db, created.id, "  a new description  ");
  expect(updated?.alt).toBe("a new description");
  const roundTrip = await getMediaById(db, created.id);
  expect(roundTrip?.alt).toBe("a new description");
  const inList = (await listMedia(db)).find((m) => m.id === created.id);
  expect(inList?.alt).toBe("a new description");
});

test("updateMediaAlt returns null for an unknown id", async () => {
  const missing = await updateMediaAlt(
    db,
    "00000000-0000-0000-0000-000000000000",
    "x",
  );
  expect(missing).toBeNull();
});

test("updateMediaBinary rewrites variant fields in place, keeping the same id", async () => {
  const created = await createMedia(db, {
    storageKey: "b/1600.jpg",
    alt: "keep me",
    width: 1600,
    height: 1200,
    responsiveSizes: [{ width: 1600, height: 1200, key: "b/1600.jpg" }],
  });
  const updated = await updateMediaBinary(db, created.id, {
    storageKey: "b/1200.jpg",
    mimeType: "image/webp",
    width: 1200,
    height: 900,
    responsiveSizes: [{ width: 1200, height: 900, key: "b/1200.jpg" }],
  });
  expect(updated?.id).toBe(created.id); // same id — references stay valid
  expect(updated?.storageKey).toBe("b/1200.jpg");
  expect(updated?.alt).toBe("keep me"); // replace swaps pixels, not the alt
  expect(updated?.responsiveSizes).toEqual([
    { width: 1200, height: 900, key: "b/1200.jpg" },
  ]);
});

test("deleteMedia removes the row and reports whether one existed", async () => {
  const created = await createMedia(db, { storageKey: "c/1600.jpg" });
  expect(await deleteMedia(db, created.id)).toBe(true);
  expect(await getMediaById(db, created.id)).toBeNull();
  expect(await deleteMedia(db, created.id)).toBe(false); // already gone
});
