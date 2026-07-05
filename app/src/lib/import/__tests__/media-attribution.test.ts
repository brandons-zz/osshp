// Issue 077 — media attribution round-trips through a full export -> import
// cycle via manifest.json's optional mediaAttribution field.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createMedia, createPost, getMediaByKey, getPostBySlug } from "@/lib/content";
import { setSetting } from "@/lib/content/settings";
import type { MediaStorage, StoredObject } from "@/lib/media";
import { collectExportEntries } from "@/lib/export";
import { buildTar } from "@/lib/export/tar";
import { sourceFromTar, sourceFromSingleMarkdown } from "../source";
import { importSource } from "../importer";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { PAGES_MODULE_ID } from "@/modules/pages/manifest";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";

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
  h = await createTestDb({ seed: true });
  db = h.db;
  storage = new FakeMediaStorage();
  await setSetting(db, "site.enabledModules", [BLOG_MODULE_ID, PAGES_MODULE_ID, PHOTOS_MODULE_ID], "admin");
});
afterEach(() => h.close());

test("attribution metadata survives a full export -> import round trip (manifest.json included)", async () => {
  storage.seed("attrib1/800.jpg", Buffer.from("img-bytes"));
  await createMedia(db, {
    storageKey: "attrib1/800.jpg",
    exifStripped: true,
    sourceUrl: "https://original-host.example/photo.jpg",
    attribution: "Photo by Jane Doe",
    license: "CC BY 4.0",
  });
  await createPost(db, {
    title: "Round Trip Post",
    slug: "round-trip-post",
    body: 'Body with ![cover](/media/attrib1/800.jpg "Photo by Jane Doe — Source: https://original-host.example/photo.jpg").',
    status: "published",
  });

  const exported = await collectExportEntries(db, storage);
  // Include manifest.json this time — the whole point of this test.
  const tar = buildTar(exported.entries.map((e) => ({ path: e.path, data: e.data })));

  const h2 = await createTestDb({ seed: true });
  await setSetting(h2.db, "site.enabledModules", [BLOG_MODULE_ID, PAGES_MODULE_ID, PHOTOS_MODULE_ID], "admin");
  const storage2 = new FakeMediaStorage();
  try {
    const { source } = await sourceFromTar(tar);
    expect(source.mediaAttribution.get("attrib1/800.jpg")).toEqual({
      sourceUrl: "https://original-host.example/photo.jpg",
      attribution: "Photo by Jane Doe",
      license: "CC BY 4.0",
    });

    const report = await importSource(h2.db, storage2, source, "skip");
    expect(report.errorCount).toBe(0);

    const post = await getPostBySlug(h2.db, "round-trip-post");
    expect(post).not.toBeNull();
    // The body text (title included) round-trips verbatim except the link.
    expect(post!.body).toContain("Photo by Jane Doe — Source: https://original-host.example/photo.jpg");

    const media = await getMediaByKey(h2.db, "attrib1/800.jpg");
    expect(media).not.toBeNull();
    expect(media!.sourceUrl).toBe("https://original-host.example/photo.jpg");
    expect(media!.attribution).toBe("Photo by Jane Doe");
    expect(media!.license).toBe("CC BY 4.0");
  } finally {
    await h2.close();
  }
});

test("an archive with no manifest.json (or a pre-issue-077 one) imports cleanly with no attribution fabricated", async () => {
  const file = `---\ntitle: "Legacy"\nslug: "legacy"\ntype: "article"\nstatus: "published"\ntags: []\npublishDate: null\ncreatedAt: null\nupdatedAt: null\nexcerpt: ""\ncoverImage: null\npanoramic: false\nshowInBlog: false\nfeatured: false\n---\n\nBody.\n`;
  const { source } = sourceFromSingleMarkdown("legacy.md", Buffer.from(file));
  expect(source.mediaAttribution.size).toBe(0);

  const report = await importSource(db, storage, source, "skip");
  expect(report.errorCount).toBe(0);
  const post = await getPostBySlug(db, "legacy");
  expect(post).not.toBeNull();
});

test("a malformed manifest.json is ignored (best-effort) rather than failing the import", async () => {
  const tar = buildTar([
    { path: "manifest.json", data: Buffer.from("{ not valid json") },
    {
      path: "posts/x.md",
      data: Buffer.from(
        `---\ntitle: "X"\nslug: "x"\ntype: "article"\nstatus: "published"\ntags: []\npublishDate: null\ncreatedAt: null\nupdatedAt: null\nexcerpt: ""\ncoverImage: null\npanoramic: false\nshowInBlog: false\nfeatured: false\n---\n\nBody.\n`,
      ),
    },
  ]);
  const { source } = await sourceFromTar(tar);
  expect(source.mediaAttribution.size).toBe(0);
  const report = await importSource(db, storage, source, "skip");
  expect(report.errorCount).toBe(0);
  expect(await getPostBySlug(db, "x")).not.toBeNull();
});
