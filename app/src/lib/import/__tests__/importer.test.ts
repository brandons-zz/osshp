import { afterEach, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createPage, createPost, getPageBySlug, getPostBySlug, listPages, listPosts } from "@/lib/content";
import type { MediaStorage, StoredObject } from "@/lib/media";
import { collectExportEntries } from "@/lib/export";
import { sourceFromSingleMarkdown, sourceFromTar } from "../source";
import { importSource } from "../importer";
import { buildTar } from "@/lib/export/tar";

/** In-memory MediaStorage double, matching the export test's convention. */
class FakeMediaStorage implements MediaStorage {
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  seed(key: string, body: Buffer, contentType = "image/jpeg"): void {
    this.objects.set(key, { body, contentType });
  }
  has(key: string): boolean {
    return this.objects.has(key);
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

function md(fields: Record<string, unknown>, body: string): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

test("single valid Markdown file creates one post with all frontmatter fields mapped", async () => {
  const file = md(
    {
      title: "Hello World",
      slug: "hello-world",
      type: "article",
      status: "published",
      tags: [{ name: "Foo", slug: "foo" }],
      publishDate: "2026-01-01T00:00:00.000Z",
      excerpt: "An excerpt.",
      coverImage: null,
      panoramic: false,
      showInBlog: true,
    },
    "# Hello\n\nBody text.",
  );
  const { source } = sourceFromSingleMarkdown("hello-world.md", Buffer.from(file));
  const report = await importSource(db, storage, source, "skip");

  expect(report.createdCount).toBe(1);
  expect(report.errorCount).toBe(0);
  const post = await getPostBySlug(db, "hello-world");
  expect(post).not.toBeNull();
  expect(post!.title).toBe("Hello World");
  expect(post!.status).toBe("published");
  expect(post!.tags).toEqual([{ id: post!.tags[0].id, name: "Foo", slug: "foo" }]);
  expect(post!.excerpt).toBe("An excerpt.");
  expect(post!.showInBlog).toBe(true);
  expect(post!.body).toContain("Body text.");
});

test("bulk-importing N valid files (a tar archive) creates N entries", async () => {
  const tar = buildTar([
    { path: "posts/one.md", data: Buffer.from(md({ title: "One", slug: "one", type: "article" }, "body one")) },
    { path: "posts/two.md", data: Buffer.from(md({ title: "Two", slug: "two", type: "article" }, "body two")) },
    { path: "pages/about.md", data: Buffer.from(md({ title: "About", slug: "about", type: "page" }, "about body")) },
  ]);
  const { source } = await sourceFromTar(tar);
  const report = await importSource(db, storage, source, "skip");

  expect(report.createdCount).toBe(3);
  expect((await listPosts(db)).length).toBe(2);
  expect((await listPages(db)).length).toBe(1);
});

test("re-import mode=skip leaves the existing entry untouched and reports skipped-with-reason", async () => {
  await createPost(db, { title: "Original", slug: "x", body: "original body", status: "draft" });
  const file = md({ title: "New Title", slug: "x", type: "article" }, "new body");
  const { source } = sourceFromSingleMarkdown("x.md", Buffer.from(file));

  const report = await importSource(db, storage, source, "skip");
  expect(report.skippedCount).toBe(1);
  expect(report.items[0].reason).toContain("already exists");

  const post = await getPostBySlug(db, "x");
  expect(post!.title).toBe("Original");
  expect(post!.body).toContain("original body");
});

test("re-import mode=overwrite replaces the existing entry's fields in place", async () => {
  const original = await createPost(db, { title: "Original", slug: "x", body: "original body", status: "draft" });
  const file = md({ title: "New Title", slug: "x", type: "article", status: "published" }, "new body");
  const { source } = sourceFromSingleMarkdown("x.md", Buffer.from(file));

  const report = await importSource(db, storage, source, "overwrite");
  expect(report.updatedCount).toBe(1);

  const post = await getPostBySlug(db, "x");
  expect(post!.id).toBe(original.id); // same row, updated in place
  expect(post!.title).toBe("New Title");
  expect(post!.status).toBe("published");
  expect(post!.body).toContain("new body");

  // No duplicate created.
  expect((await listPosts(db)).length).toBe(1);
});

test("re-import mode=create always creates a new entry, disambiguating a colliding slug", async () => {
  await createPost(db, { title: "Original", slug: "x", body: "original body", status: "draft" });
  const file = md({ title: "New Title", slug: "x", type: "article" }, "new body");
  const { source } = sourceFromSingleMarkdown("x.md", Buffer.from(file));

  const report = await importSource(db, storage, source, "create");
  expect(report.createdCount).toBe(1);
  expect(report.items[0].slug).toBe("x-2");
  expect(report.items[0].reason).toContain("already taken");

  expect((await listPosts(db)).length).toBe(2);
  const original = await getPostBySlug(db, "x");
  expect(original!.title).toBe("Original"); // never clobbered
  const created = await getPostBySlug(db, "x-2");
  expect(created!.title).toBe("New Title");
});

test("mode=create with no collision uses the original slug (no gratuitous disambiguation)", async () => {
  const file = md({ title: "Fresh", slug: "fresh", type: "article" }, "body");
  const { source } = sourceFromSingleMarkdown("fresh.md", Buffer.from(file));
  const report = await importSource(db, storage, source, "create");
  expect(report.items[0].slug).toBe("fresh");
  expect(report.items[0].reason).toBeUndefined();
});

test("a malformed file is reported with a reason and does not abort the batch", async () => {
  const tar = buildTar([
    { path: "posts/good.md", data: Buffer.from(md({ title: "Good", slug: "good", type: "article" }, "ok")) },
    { path: "posts/bad.md", data: Buffer.from("not frontmatter at all") },
  ]);
  const { source } = await sourceFromTar(tar);
  const report = await importSource(db, storage, source, "skip");

  expect(report.createdCount).toBe(1);
  expect(report.errorCount).toBe(1);
  const bad = report.items.find((i) => i.path === "posts/bad.md")!;
  expect(bad.outcome).toBe("error");
  expect(bad.reason).toBeTruthy();
  expect((await listPosts(db)).length).toBe(1); // the good file still landed
});

test("referenced media is ingested into the media store and links are rewritten to resolve", async () => {
  const tar = buildTar([
    {
      path: "posts/photo.md",
      data: Buffer.from(
        md(
          { title: "Photo Post", slug: "photo-post", type: "article", coverImage: { src: "media/abc/800.jpg", alt: "cover" } },
          "See ![x](media/abc/800.jpg) here.",
        ),
      ),
    },
    { path: "media/abc/800.jpg", data: Buffer.from("jpeg-bytes") },
  ]);
  const { source } = await sourceFromTar(tar);
  const report = await importSource(db, storage, source, "skip");

  expect(report.mediaImportedCount).toBe(1);
  expect(report.mediaErrors).toEqual([]);
  expect(storage.has("abc/800.jpg")).toBe(true);

  const post = await getPostBySlug(db, "photo-post");
  expect(post!.coverImage).toEqual({ src: "/media/abc/800.jpg", alt: "cover" });
  expect(post!.body).toContain("/media/abc/800.jpg");
  expect(post!.body).not.toContain("(media/abc/800.jpg)"); // archive-relative form is gone
});

test("a media reference with no bytes included is recorded in mediaErrors, not silently dropped", async () => {
  const file = md({ title: "X", slug: "x", type: "article" }, "See ![x](media/missing/800.jpg).");
  const { source } = sourceFromSingleMarkdown("x.md", Buffer.from(file));
  const report = await importSource(db, storage, source, "skip");
  expect(report.mediaErrors).toEqual(["missing/800.jpg"]);
  // Import still succeeds — a missing media file is not a fatal error.
  expect(report.createdCount).toBe(1);
});

test("full export -> import round-trip is lossless for a representative post and page", async () => {
  storage.seed("k1/800.jpg", Buffer.from("img-bytes"));
  await createPost(db, {
    title: "Round Trip Post",
    slug: "round-trip-post",
    body: "Body with ![cover](/media/k1/800.jpg) media.",
    excerpt: "An excerpt.",
    coverImage: { src: "/media/k1/800.jpg", alt: "cover alt" },
    type: "photo-post",
    panoramic: true,
    showInBlog: true,
    status: "scheduled",
    publishDate: "2099-06-01T00:00:00.000Z",
    tags: [{ name: "Travel", slug: "travel" }],
  });
  await createPage(db, {
    title: "Round Trip Page",
    slug: "round-trip-page",
    body: "# Page body",
    status: "published",
    showInNav: true,
  });

  const exported = await collectExportEntries(db, storage);
  const tarEntries = exported.entries
    .filter((e) => e.path !== "manifest.json")
    .map((e) => ({ path: e.path, data: e.data }));
  const tar = buildTar(tarEntries);

  // Import into a FRESH, empty database — proves the archive is self-contained.
  const h2 = await createTestDb();
  const storage2 = new FakeMediaStorage();
  try {
    const { source } = await sourceFromTar(tar);
    const report = await importSource(h2.db, storage2, source, "skip");
    expect(report.errorCount).toBe(0);
    expect(report.createdCount).toBe(2);

    const post = await getPostBySlug(h2.db, "round-trip-post");
    expect(post).not.toBeNull();
    expect(post!.title).toBe("Round Trip Post");
    expect(post!.body).toBe("Body with ![cover](/media/k1/800.jpg) media.");
    expect(post!.excerpt).toBe("An excerpt.");
    expect(post!.coverImage).toEqual({ src: "/media/k1/800.jpg", alt: "cover alt" });
    expect(post!.type).toBe("photo-post");
    expect(post!.panoramic).toBe(true);
    expect(post!.showInBlog).toBe(true);
    expect(post!.status).toBe("scheduled");
    expect(post!.publishDate).toBe("2099-06-01T00:00:00.000Z");
    expect(post!.tags.map((t) => ({ name: t.name, slug: t.slug }))).toEqual([{ name: "Travel", slug: "travel" }]);

    const page = await getPageBySlug(h2.db, "round-trip-page");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Round Trip Page");
    expect(page!.body).toBe("# Page body");
    expect(page!.showInNav).toBe(true);
    expect(page!.status).toBe("published");

    expect(storage2.has("k1/800.jpg")).toBe(true);
  } finally {
    await h2.close();
  }
});

test("import preserves the original createdAt/updatedAt from the source (lossless timestamps)", async () => {
  const file = md(
    {
      title: "X",
      slug: "x",
      type: "article",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-06-01T00:00:00.000Z",
    },
    "body",
  );
  const { source } = sourceFromSingleMarkdown("x.md", Buffer.from(file));
  await importSource(db, storage, source, "skip");
  const post = await getPostBySlug(db, "x");
  expect(post!.createdAt).toBe("2020-01-01T00:00:00.000Z");
  expect(post!.updatedAt).toBe("2020-06-01T00:00:00.000Z");
});

test("mode=overwrite restores the source's original timestamps rather than stamping now()", async () => {
  await createPost(db, { title: "Original", slug: "x", body: "b", status: "draft" });
  const file = md(
    { title: "X", slug: "x", type: "article", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-06-01T00:00:00.000Z" },
    "body",
  );
  const { source } = sourceFromSingleMarkdown("x.md", Buffer.from(file));
  await importSource(db, storage, source, "overwrite");
  const post = await getPostBySlug(db, "x");
  expect(post!.createdAt).toBe("2020-01-01T00:00:00.000Z");
  expect(post!.updatedAt).toBe("2020-06-01T00:00:00.000Z");
});

test("archive-level errors (e.g. a rejected traversal entry) are merged into the same report", async () => {
  const tar = buildTar([{ path: "media/x/800.jpg", data: Buffer.from("bytes") }]);
  const patched = Buffer.from(tar);
  const evil = "../../../etc/passwd";
  patched.write(evil, 0, 100, "utf8");
  patched.fill(0, evil.length, 100);
  patched.write("        ", 148, 8, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += patched[i];
  patched.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");

  const { source, entryErrors } = await sourceFromTar(patched);
  const report = await importSource(db, storage, source, "skip", entryErrors);
  expect(report.errorCount).toBe(1);
  expect(report.items[0].reason).toContain("unsafe archive path");
});

test("an existing tag is reused (get-or-create by slug), not duplicated", async () => {
  await createPost(db, { title: "First", slug: "first", body: "b", tags: [{ name: "Foo", slug: "foo" }] });
  const file = md({ title: "Second", slug: "second", type: "article", tags: [{ name: "Foo", slug: "foo" }] }, "body");
  const { source } = sourceFromSingleMarkdown("second.md", Buffer.from(file));
  await importSource(db, storage, source, "skip");

  const rows = await db.query<{ count: string }>(`SELECT COUNT(*)::text as count FROM tags WHERE slug = 'foo'`);
  expect(rows[0].count).toBe("1");
});
