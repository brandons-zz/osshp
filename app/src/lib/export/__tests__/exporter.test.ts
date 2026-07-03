import { afterEach, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createPage } from "@/lib/content/pages";
import { createPost } from "@/lib/content/posts";
import type { MediaStorage, StoredObject } from "@/lib/media";
import {
  buildExportArchive,
  collectExportEntries,
  writeExportToDirectory,
} from "../exporter";

/** In-memory MediaStorage double — no live Garage needed to test the pipeline. */
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
    return {
      stream: Readable.from([obj.body]),
      contentType: obj.contentType,
      size: obj.body.length,
    };
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

test("exports posts of every status, not just published (full-backup scope)", async () => {
  await createPost(db, { title: "P", slug: "published", body: "x", status: "published" });
  await createPost(db, { title: "D", slug: "draft", body: "x", status: "draft" });
  await createPost(db, {
    title: "S",
    slug: "scheduled",
    body: "x",
    status: "scheduled",
    publishDate: "2099-01-01T00:00:00.000Z",
  });

  const result = await collectExportEntries(db, storage);
  expect(result.manifest.postCount).toBe(3);
  const paths = result.entries.map((e) => e.path);
  expect(paths).toContain("posts/published.md");
  expect(paths).toContain("posts/draft.md");
  expect(paths).toContain("posts/scheduled.md");
});

test("copies referenced media in, rewrites the link, and dedupes across posts", async () => {
  storage.seed("shared-key/800.jpg", Buffer.from("bytes-a"));

  await createPost(db, {
    title: "One",
    slug: "one",
    body: "See ![cover](/media/shared-key/800.jpg) here.",
    status: "published",
    coverImage: { src: "/media/shared-key/800.jpg", alt: "cover" },
  });
  await createPost(db, {
    title: "Two",
    slug: "two",
    body: "Also uses ![same](/media/shared-key/800.jpg).",
    status: "published",
  });

  const result = await collectExportEntries(db, storage);

  // Deduped: one media entry despite two posts referencing the same key.
  const mediaEntries = result.entries.filter((e) => e.path.startsWith("media/"));
  expect(mediaEntries.length).toBe(1);
  expect(mediaEntries[0].path).toBe("media/shared-key/800.jpg");
  expect(mediaEntries[0].data.toString("utf8")).toBe("bytes-a");
  expect(result.manifest.mediaCount).toBe(1);

  const one = result.entries.find((e) => e.path === "posts/one.md")!;
  const text = one.data.toString("utf8");
  expect(text).toContain("media/shared-key/800.jpg"); // body rewritten
  expect(text).toContain('"src":"media/shared-key/800.jpg"'); // coverImage.src rewritten
  expect(text).not.toContain('"/media/shared-key/800.jpg"'); // no un-rewritten absolute ref left
});

test("a stale media reference is recorded in manifest.mediaErrors, not silently dropped", async () => {
  await createPost(db, {
    title: "Broken",
    slug: "broken",
    body: "![missing](/media/does-not-exist/800.jpg)",
    status: "published",
  });

  const result = await collectExportEntries(db, storage);
  expect(result.manifest.mediaErrors).toEqual(["does-not-exist/800.jpg"]);
  expect(result.entries.some((e) => e.path.startsWith("media/"))).toBe(false);
});

test("pages are exported alongside posts, and manifest.json is included", async () => {
  await createPage(db, { title: "About", slug: "about", body: "# About", status: "published" });

  const result = await collectExportEntries(db, storage);
  expect(result.manifest.pageCount).toBe(1);
  const paths = result.entries.map((e) => e.path);
  expect(paths).toContain("pages/about.md");
  expect(paths).toContain("manifest.json");

  const manifestEntry = result.entries.find((e) => e.path === "manifest.json")!;
  const parsed = JSON.parse(manifestEntry.data.toString("utf8"));
  expect(parsed.postCount).toBe(0);
  expect(parsed.pageCount).toBe(1);
});

test("buildExportArchive produces a gzip-compressed tar that decompresses back to the same entries", async () => {
  storage.seed("k1/800.jpg", Buffer.from("img-bytes"));
  await createPost(db, {
    title: "Hi",
    slug: "hi",
    body: "![x](/media/k1/800.jpg)",
    status: "published",
  });

  const result = await collectExportEntries(db, storage);
  const archive = buildExportArchive(result.entries);

  // gzip magic bytes
  expect(archive[0]).toBe(0x1f);
  expect(archive[1]).toBe(0x8b);

  // Decompress with the same Bun runtime the archive was built under, then
  // spot-check that the known entries survived the tar+gzip round trip.
  const tarBytes = Buffer.from((globalThis as unknown as { Bun: { gunzipSync: (b: Uint8Array) => Uint8Array } }).Bun.gunzipSync(archive));
  const tarText = tarBytes.toString("utf8");
  expect(tarText).toContain("posts/hi.md");
  expect(tarText).toContain("media/k1/800.jpg");
  expect(tarText).toContain("img-bytes");
});

test("writeExportToDirectory writes every entry to disk, creating nested dirs", async () => {
  storage.seed("k1/800.jpg", Buffer.from("img-bytes"));
  await createPost(db, {
    title: "Hi",
    slug: "hi",
    body: "![x](/media/k1/800.jpg)",
    status: "published",
  });

  const result = await collectExportEntries(db, storage);
  const dir = await mkdtemp(join(tmpdir(), "osshp-export-test-"));
  try {
    await writeExportToDirectory(result.entries, dir);

    const postFile = await readFile(join(dir, "posts/hi.md"), "utf8");
    expect(postFile).toContain("media/k1/800.jpg");

    const mediaFile = await readFile(join(dir, "media/k1/800.jpg"));
    expect(mediaFile.toString("utf8")).toBe("img-bytes");

    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    expect(manifest.postCount).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
