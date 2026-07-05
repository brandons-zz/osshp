import { afterEach, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createPage } from "@/lib/content/pages";
import { createPost } from "@/lib/content/posts";
import { createMedia } from "@/lib/content/media";
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

test("issue 050 — a gallery post exports its images, order, captions, and explicit cover as portable media-key fields", async () => {
  storage.seed("g1/800.jpg", Buffer.from("bytes-1"));
  storage.seed("g2/800.jpg", Buffer.from("bytes-2"));
  const m1 = await createMedia(db, { storageKey: "g1/800.jpg", alt: "first" });
  const m2 = await createMedia(db, { storageKey: "g2/800.jpg", alt: "second" });

  await createPost(db, {
    title: "Gallery Post",
    slug: "gallery-post",
    body: "A gallery post, no inline images.",
    status: "published",
    type: "photo-post",
    isGallery: true,
    coverMediaId: m2.id, // explicit choice — not the first image in order
    gallery: [
      { mediaId: m1.id, caption: "one" },
      { mediaId: m2.id, caption: "two" },
    ],
  });

  const result = await collectExportEntries(db, storage);

  // Both gallery images are copied into the archive, same as coverImage/body refs.
  const mediaEntries = result.entries.filter((e) => e.path.startsWith("media/"));
  expect(mediaEntries.map((e) => e.path).sort()).toEqual(["media/g1/800.jpg", "media/g2/800.jpg"]);
  expect(result.manifest.mediaCount).toBe(2);

  const entry = result.entries.find((e) => e.path === "posts/gallery-post.md")!;
  const text = entry.data.toString("utf8");
  expect(text).toContain("isGallery: true");
  // Order preserved, src rewritten to the archive-relative form, alt/caption carried.
  expect(text).toContain(
    'gallery: [{"src":"media/g1/800.jpg","alt":"first","caption":"one"},{"src":"media/g2/800.jpg","alt":"second","caption":"two"}]',
  );
  // The explicit (non-first) cover choice survives as a portable media key.
  expect(text).toContain('galleryCover: "media/g2/800.jpg"');
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

// issue 072 defense-in-depth: the create/update routes bound slug length going
// forward, but a row that predates that bound (or reached the DB by some other
// path) must not throw and abort the ENTIRE export — it is skipped and
// recorded in manifest.contentErrors instead, exactly like a stale media
// reference already degrades into manifest.mediaErrors above. This is the
// regression for the original defect: pre-fix, this exact scenario made
// GET /api/admin/export throw (uncaught) on every subsequent call.
test("a post whose slug is too long for a USTAR path is skipped, not thrown, and export succeeds for the rest", async () => {
  // createPost has no length cap itself (only the route does) — this
  // reproduces a pre-existing/legacy row that slipped past the route.
  const overlongSlug = "a".repeat(240);
  await createPost(db, {
    title: "Overlong",
    slug: overlongSlug,
    body: "x",
    status: "published",
  });
  await createPost(db, {
    title: "Fine",
    slug: "totally-fine",
    body: "x",
    status: "published",
  });

  const result = await collectExportEntries(db, storage);

  // The valid post is exported normally.
  const paths = result.entries.map((e) => e.path);
  expect(paths).toContain("posts/totally-fine.md");
  // The unrepresentable one is excluded, not silently missing — it is named
  // in the manifest so the operator knows exactly what didn't make it in.
  expect(paths.some((p) => p.includes(overlongSlug))).toBe(false);
  expect(result.manifest.contentErrors).toEqual([`posts/${overlongSlug}.md`]);

  // buildExportArchive (the actual throw site in issue 072) must not throw
  // either — this is the exact call GET /api/admin/export makes.
  expect(() => buildExportArchive(result.entries)).not.toThrow();
});

test("a page whose slug is too long for a USTAR path is skipped, not thrown", async () => {
  const overlongSlug = "p".repeat(240);
  await createPage(db, {
    title: "Overlong Page",
    slug: overlongSlug,
    body: "x",
    status: "published",
  });

  const result = await collectExportEntries(db, storage);
  expect(result.manifest.contentErrors).toEqual([`pages/${overlongSlug}.md`]);
  expect(() => buildExportArchive(result.entries)).not.toThrow();
});

test("normal-length slugs never populate manifest.contentErrors", async () => {
  await createPost(db, { title: "P", slug: "normal-slug", body: "x", status: "published" });
  await createPage(db, { title: "Pg", slug: "normal-page", body: "x", status: "published" });

  const result = await collectExportEntries(db, storage);
  expect(result.manifest.contentErrors).toEqual([]);
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
