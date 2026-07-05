// Issue 077 — media attribution metadata in the export manifest.
//
// mediaAttribution is keyed by the SAME archive-relative media key as the
// media/<key> entries, and only populated for media that actually carries
// attribution (an ordinary upload with none of the three fields set must not
// pollute the manifest).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createPost } from "@/lib/content/posts";
import { createMedia } from "@/lib/content/media";
import type { MediaStorage, StoredObject } from "@/lib/media";
import { collectExportEntries } from "../exporter";

class FakeMediaStorage implements MediaStorage {
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  seed(key: string, body: Buffer, contentType = "image/jpeg"): void {
    this.objects.set(key, { body, contentType });
  }
  async ensureBucket(): Promise<void> {}
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
  async get(key: string): Promise<StoredObject> {
    const obj = this.objects.get(key);
    if (!obj) throw new Error(`not found: ${key}`);
    return { stream: Readable.from([obj.body]), contentType: obj.contentType, size: obj.body.length };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

let h: TestDb;
let db: Db;
let storage: FakeMediaStorage;

beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
  storage = new FakeMediaStorage();
});
afterEach(() => h.close());

test("manifest.mediaAttribution records source/attribution/license for an auto-imported image", async () => {
  storage.seed("auto123/800.jpg", Buffer.from("bytes"));
  await createMedia(db, {
    storageKey: "auto123/800.jpg",
    exifStripped: true,
    sourceUrl: "https://original-host.example/photo.jpg",
    attribution: "Photo by Jane Doe",
    license: "CC BY 4.0",
  });
  await createPost(db, {
    title: "P",
    slug: "p",
    body: "![alt](/media/auto123/800.jpg)",
    status: "published",
  });

  const result = await collectExportEntries(db, storage);
  expect(result.manifest.mediaAttribution).toBeDefined();
  expect(result.manifest.mediaAttribution!["auto123/800.jpg"]).toEqual({
    sourceUrl: "https://original-host.example/photo.jpg",
    attribution: "Photo by Jane Doe",
    license: "CC BY 4.0",
  });
});

test("an ordinary upload with no attribution fields does not appear in mediaAttribution at all", async () => {
  storage.seed("plain456/800.jpg", Buffer.from("bytes"));
  await createMedia(db, { storageKey: "plain456/800.jpg", exifStripped: true });
  await createPost(db, {
    title: "Q",
    slug: "q",
    body: "![alt](/media/plain456/800.jpg)",
    status: "published",
  });

  const result = await collectExportEntries(db, storage);
  const has = result.manifest.mediaAttribution?.["plain456/800.jpg"];
  expect(has).toBeUndefined();
});

test("manifest.mediaAttribution is entirely absent when nothing in the export has attribution", async () => {
  storage.seed("nofrills/800.jpg", Buffer.from("bytes"));
  await createMedia(db, { storageKey: "nofrills/800.jpg", exifStripped: true });
  await createPost(db, {
    title: "R",
    slug: "r",
    body: "![alt](/media/nofrills/800.jpg)",
    status: "published",
  });

  const result = await collectExportEntries(db, storage);
  expect(result.manifest.mediaAttribution).toBeUndefined();
});
