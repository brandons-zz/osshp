import { afterEach, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import {
  createMedia,
  createPage,
  createPost,
  getPageBySlug,
  getPostBySlug,
  listPages,
  listPosts,
} from "@/lib/content";
import { setSetting } from "@/lib/content/settings";
import type { MediaStorage, StoredObject } from "@/lib/media";
import { collectExportEntries } from "@/lib/export";
import { sourceFromSingleMarkdown, sourceFromTar } from "../source";
import { importSource } from "../importer";
import { buildTar } from "@/lib/export/tar";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { PAGES_MODULE_ID } from "@/modules/pages/manifest";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";

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
  // Issue 069: import now gates per item on the owning module's enabled
  // state (same as the blog/pages/photos admin routes). All three content
  // modules enabled by default so these pre-existing behavior tests are
  // unaffected; the module-gate test file below exercises narrower sets.
  await setSetting(
    db,
    "site.enabledModules",
    [BLOG_MODULE_ID, PAGES_MODULE_ID, PHOTOS_MODULE_ID],
    "admin",
  );
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
  const h2 = await createTestDb({ seed: true });
  // Issue 069: this fresh DB also needs its content modules enabled, same as
  // the primary `db` above — otherwise the import into it is rejected by the
  // new per-item module gate before the round-trip assertions run.
  await setSetting(
    h2.db,
    "site.enabledModules",
    [BLOG_MODULE_ID, PAGES_MODULE_ID, PHOTOS_MODULE_ID],
    "admin",
  );
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
    // Issue 050 AC: a non-gallery (single-photo) post round-trips unchanged —
    // no gallery membership is fabricated for it.
    expect(post!.isGallery).toBe(false);
    expect(post!.gallery).toEqual([]);
    expect(post!.coverMediaId).toBeNull();

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

test("issue 050 — export -> import round-trip restores gallery images, order, captions, and an explicit (non-first) cover", async () => {
  storage.seed("g1/800.jpg", Buffer.from("bytes-1"));
  storage.seed("g2/800.jpg", Buffer.from("bytes-2"));
  storage.seed("g3/800.jpg", Buffer.from("bytes-3"));
  const m1 = await createMedia(db, { storageKey: "g1/800.jpg", alt: "alt one" });
  const m2 = await createMedia(db, { storageKey: "g2/800.jpg", alt: "alt two" });
  const m3 = await createMedia(db, { storageKey: "g3/800.jpg", alt: "alt three" });

  await createPost(db, {
    title: "Gallery Round Trip",
    slug: "gallery-round-trip",
    body: "A gallery post — no inline images in the body itself.",
    status: "published",
    type: "photo-post",
    isGallery: true,
    coverMediaId: m3.id, // explicit choice — the THIRD image, not the first
    gallery: [
      { mediaId: m1.id, caption: "one" },
      { mediaId: m2.id, caption: "two" },
      { mediaId: m3.id, caption: "three" },
    ],
  });

  const exported = await collectExportEntries(db, storage);
  const tar = buildTar(exported.entries.filter((e) => e.path !== "manifest.json"));

  // Import into a FRESH, empty database — the new mediaIds/postId will differ
  // from the source instance's, proving the round-trip doesn't depend on them.
  const h2 = await createTestDb({ seed: true });
  // Issue 069: this fresh DB also needs its content modules enabled, same as
  // the primary `db` above — otherwise the import into it is rejected by the
  // new per-item module gate before the round-trip assertions run.
  await setSetting(
    h2.db,
    "site.enabledModules",
    [BLOG_MODULE_ID, PAGES_MODULE_ID, PHOTOS_MODULE_ID],
    "admin",
  );
  const storage2 = new FakeMediaStorage();
  try {
    const { source } = await sourceFromTar(tar);
    const report = await importSource(h2.db, storage2, source, "skip");
    expect(report.errorCount).toBe(0);
    expect(report.createdCount).toBe(1);
    expect(report.mediaErrors).toEqual([]);

    const post = await getPostBySlug(h2.db, "gallery-round-trip");
    expect(post).not.toBeNull();
    expect(post!.isGallery).toBe(true);
    // Order restored (array order = position), captions and alts intact.
    expect(post!.gallery.map((g) => ({ src: g.src, alt: g.alt, caption: g.caption }))).toEqual([
      { src: "/media/g1/800.jpg", alt: "alt one", caption: "one" },
      { src: "/media/g2/800.jpg", alt: "alt two", caption: "two" },
      { src: "/media/g3/800.jpg", alt: "alt three", caption: "three" },
    ]);
    // The explicit (non-first) cover choice survived: the derived cover is
    // the THIRD image, not the first — proving coverMediaId round-tripped,
    // not just gallery membership.
    expect(post!.coverImage).toEqual({ src: "/media/g3/800.jpg", alt: "alt three" });

    expect(storage2.has("g1/800.jpg")).toBe(true);
    expect(storage2.has("g2/800.jpg")).toBe(true);
    expect(storage2.has("g3/800.jpg")).toBe(true);
  } finally {
    await h2.close();
  }
});

test("issue 050 — an unset gallery cover still defaults to the first image after round-trip", async () => {
  storage.seed("d1/800.jpg", Buffer.from("b1"));
  storage.seed("d2/800.jpg", Buffer.from("b2"));
  const m1 = await createMedia(db, { storageKey: "d1/800.jpg", alt: "d1" });
  const m2 = await createMedia(db, { storageKey: "d2/800.jpg", alt: "d2" });

  await createPost(db, {
    title: "No Explicit Cover",
    slug: "no-explicit-cover",
    body: "gallery, no pinned cover",
    status: "published",
    type: "photo-post",
    isGallery: true,
    // coverMediaId intentionally omitted -> defaults to the first gallery image
    gallery: [{ mediaId: m1.id }, { mediaId: m2.id }],
  });

  const exported = await collectExportEntries(db, storage);
  const tar = buildTar(exported.entries.filter((e) => e.path !== "manifest.json"));
  const h2 = await createTestDb({ seed: true });
  // Issue 069: this fresh DB also needs its content modules enabled, same as
  // the primary `db` above — otherwise the import into it is rejected by the
  // new per-item module gate before the round-trip assertions run.
  await setSetting(
    h2.db,
    "site.enabledModules",
    [BLOG_MODULE_ID, PAGES_MODULE_ID, PHOTOS_MODULE_ID],
    "admin",
  );
  const storage2 = new FakeMediaStorage();
  try {
    const { source } = await sourceFromTar(tar);
    await importSource(h2.db, storage2, source, "skip");
    const post = await getPostBySlug(h2.db, "no-explicit-cover");
    expect(post!.coverImage).toEqual({ src: "/media/d1/800.jpg", alt: "d1" });
  } finally {
    await h2.close();
  }
});

test("issue 050 — a gallery entry whose media bytes are missing from the archive is dropped, not fatal", async () => {
  const m1 = await createMedia(db, { storageKey: "present/800.jpg", alt: "present" });
  storage.seed("present/800.jpg", Buffer.from("bytes"));
  await createPost(db, {
    title: "Partial Gallery",
    slug: "partial-gallery",
    body: "gallery",
    status: "published",
    type: "photo-post",
    isGallery: true,
    gallery: [{ mediaId: m1.id, caption: "kept" }],
  });

  const exported = await collectExportEntries(db, storage);
  // Simulate an archive that lost the referenced media file (e.g. hand-edited,
  // or a mediaErrors case at export time) by dropping its media/ entry before
  // importing — the gallery frontmatter field still names it.
  const tarEntries = exported.entries.filter(
    (e) => e.path !== "manifest.json" && e.path !== "media/present/800.jpg",
  );
  const tar = buildTar(tarEntries);

  const h2 = await createTestDb({ seed: true });
  // Issue 069: this fresh DB also needs its content modules enabled, same as
  // the primary `db` above — otherwise the import into it is rejected by the
  // new per-item module gate before the round-trip assertions run.
  await setSetting(
    h2.db,
    "site.enabledModules",
    [BLOG_MODULE_ID, PAGES_MODULE_ID, PHOTOS_MODULE_ID],
    "admin",
  );
  const storage2 = new FakeMediaStorage();
  try {
    const { source } = await sourceFromTar(tar);
    const report = await importSource(h2.db, storage2, source, "skip");
    expect(report.errorCount).toBe(0); // one bad gallery ref does not fail the post
    expect(report.mediaErrors).toEqual(["present/800.jpg"]);
    const post = await getPostBySlug(h2.db, "partial-gallery");
    expect(post!.isGallery).toBe(true);
    expect(post!.gallery).toEqual([]); // the only entry couldn't resolve — dropped
    // Issue 066: a published gallery whose images ALL failed to resolve must
    // not go public as an empty gallery — the publish gate demotes it to draft
    // and the report says so.
    expect(post!.status).toBe("draft");
    const item = report.items.find((i) => i.path === "posts/partial-gallery.md")!;
    expect(item.outcome).toBe("created");
    expect(item.reason).toContain("imported as draft");
  } finally {
    await h2.close();
  }
});

test("issue 066 — a published gallery with missing alts imports as DRAFT with a report entry naming the alt-less images", async () => {
  // Archive frontmatter authored directly (as a hand-edited or third-party
  // archive would be): status published, isGallery, one entry with alt and
  // two without — the exact shape that previously imported as a PUBLISHED
  // missing-alt gallery, bypassing the photos routes' publish gate.
  const tar = buildTar([
    {
      path: "posts/bad-gallery.md",
      data: Buffer.from(
        md(
          {
            title: "Bad Gallery",
            slug: "bad-gallery",
            type: "photo-post",
            status: "published",
            isGallery: true,
            gallery: [
              { src: "media/ok/800.jpg", alt: "has alt", caption: "" },
              { src: "media/noalt1/800.jpg", alt: "", caption: "c1" },
              { src: "media/noalt2/800.jpg", alt: "   ", caption: "c2" }, // whitespace-only = missing
            ],
            galleryCover: null,
          },
          "body",
        ),
      ),
    },
    { path: "media/ok/800.jpg", data: Buffer.from("b1") },
    { path: "media/noalt1/800.jpg", data: Buffer.from("b2") },
    { path: "media/noalt2/800.jpg", data: Buffer.from("b3") },
  ]);
  const { source } = await sourceFromTar(tar);
  const report = await importSource(db, storage, source, "skip");

  // Never fail the item, never lose content — imported, but as a draft.
  expect(report.errorCount).toBe(0);
  expect(report.createdCount).toBe(1);
  const item = report.items.find((i) => i.path === "posts/bad-gallery.md")!;
  expect(item.outcome).toBe("created");
  expect(item.reason).toContain("imported as draft instead of published");
  expect(item.reason).toContain("alt");
  // The report NAMES the alt-less images (and not the compliant one).
  expect(item.reason).toContain("noalt1/800.jpg");
  expect(item.reason).toContain("noalt2/800.jpg");
  expect(item.reason).not.toContain("ok/800.jpg");

  const post = await getPostBySlug(db, "bad-gallery");
  expect(post!.status).toBe("draft"); // nothing missing-alt becomes publicly visible
  expect(post!.isGallery).toBe(true);
  expect(post!.gallery.length).toBe(3); // content fully preserved, order intact
});

test("issue 066 — a published gallery with complete alts still imports as published (no false demotion)", async () => {
  const tar = buildTar([
    {
      path: "posts/good-gallery.md",
      data: Buffer.from(
        md(
          {
            title: "Good Gallery",
            slug: "good-gallery",
            type: "photo-post",
            status: "published",
            isGallery: true,
            gallery: [
              { src: "media/a/800.jpg", alt: "alt a", caption: "" },
              { src: "media/b/800.jpg", alt: "alt b", caption: "" },
            ],
            galleryCover: null,
          },
          "body",
        ),
      ),
    },
    { path: "media/a/800.jpg", data: Buffer.from("b1") },
    { path: "media/b/800.jpg", data: Buffer.from("b2") },
  ]);
  const { source } = await sourceFromTar(tar);
  const report = await importSource(db, storage, source, "skip");

  expect(report.errorCount).toBe(0);
  const item = report.items.find((i) => i.path === "posts/good-gallery.md")!;
  expect(item.outcome).toBe("created");
  expect(item.reason).toBeUndefined(); // no demotion note on a compliant import

  const post = await getPostBySlug(db, "good-gallery");
  expect(post!.status).toBe("published");
  expect(post!.gallery.length).toBe(2);
});

test("issue 066 — a DRAFT gallery with missing alts imports unchanged (drafts are alt-exempt)", async () => {
  const tar = buildTar([
    {
      path: "posts/draft-gallery.md",
      data: Buffer.from(
        md(
          {
            title: "Draft Gallery",
            slug: "draft-gallery",
            type: "photo-post",
            status: "draft",
            isGallery: true,
            gallery: [{ src: "media/wip/800.jpg", alt: "", caption: "work in progress" }],
            galleryCover: null,
          },
          "body",
        ),
      ),
    },
    { path: "media/wip/800.jpg", data: Buffer.from("b1") },
  ]);
  const { source } = await sourceFromTar(tar);
  const report = await importSource(db, storage, source, "skip");

  expect(report.errorCount).toBe(0);
  const item = report.items.find((i) => i.path === "posts/draft-gallery.md")!;
  expect(item.outcome).toBe("created");
  expect(item.reason).toBeUndefined(); // no demotion noise on a legitimately alt-exempt draft

  const post = await getPostBySlug(db, "draft-gallery");
  expect(post!.status).toBe("draft");
  expect(post!.isGallery).toBe(true);
  expect(post!.gallery.map((g) => g.caption)).toEqual(["work in progress"]);
});

test("issue 066 — a hand-authored ZERO-image published gallery imports as DRAFT with a report entry", async () => {
  // isGallery:true + gallery:[] + status:published — never producible by our
  // own exporter for a publishable gallery, but trivially hand-authorable.
  // A gallery may import as published only with >=1 resolved image AND
  // complete alts; zero images fails that and demotes to draft.
  const file = md(
    {
      title: "Empty Gallery",
      slug: "empty-gallery",
      type: "photo-post",
      status: "published",
      isGallery: true,
      gallery: [],
      galleryCover: null,
    },
    "body",
  );
  const { source } = sourceFromSingleMarkdown("empty-gallery.md", Buffer.from(file));
  const report = await importSource(db, storage, source, "skip");

  expect(report.errorCount).toBe(0); // never fail the item
  const item = report.items.find((i) => i.path === "empty-gallery.md")!;
  expect(item.outcome).toBe("created");
  expect(item.reason).toContain("imported as draft instead of published");
  expect(item.reason).toContain("at least one photograph");

  const post = await getPostBySlug(db, "empty-gallery");
  expect(post!.status).toBe("draft"); // never publicly visible as an empty gallery
  expect(post!.isGallery).toBe(true);
  expect(post!.gallery).toEqual([]);
});

test("issue 066 — a gallery exceeding MAX_GALLERY_SIZE is capped at the limit with a report entry", async () => {
  // 105 entries, all with alts and all media present — isolates the size cap
  // from the alt gate. The route layer rejects >100-image galleries outright;
  // import must not be able to construct what the route forbids, so the
  // excess is dropped (order-preserving) and the report says how many.
  const COUNT = 105;
  const entries: Array<{ path: string; data: Buffer }> = [];
  const galleryField: Array<{ src: string; alt: string; caption: string }> = [];
  for (let i = 0; i < COUNT; i++) {
    const key = `big${i}/800.jpg`;
    entries.push({ path: `media/${key}`, data: Buffer.from(`b${i}`) });
    galleryField.push({ src: `media/${key}`, alt: `alt ${i}`, caption: "" });
  }
  entries.push({
    path: "posts/big-gallery.md",
    data: Buffer.from(
      md(
        {
          title: "Big Gallery",
          slug: "big-gallery",
          type: "photo-post",
          status: "published",
          isGallery: true,
          gallery: galleryField,
          galleryCover: null,
        },
        "body",
      ),
    ),
  });
  const tar = buildTar(entries);
  const { source } = await sourceFromTar(tar);
  const report = await importSource(db, storage, source, "skip");

  expect(report.errorCount).toBe(0);
  const item = report.items.find((i) => i.path === "posts/big-gallery.md")!;
  expect(item.outcome).toBe("created");
  expect(item.reason).toContain("capped at the 100-image limit");
  expect(item.reason).toContain("5 excess images dropped");

  const post = await getPostBySlug(db, "big-gallery");
  expect(post!.gallery.length).toBe(100); // first 100 kept, order preserved
  expect(post!.gallery[0].src).toBe("/media/big0/800.jpg");
  expect(post!.gallery[99].src).toBe("/media/big99/800.jpg");
  // All alts complete, so the cap alone does not demote — still published.
  expect(post!.status).toBe("published");
});

test("issue 050 — a pre-gallery (old-format) archive with no gallery fields at all imports cleanly (backward compat)", async () => {
  // No isGallery/gallery/galleryCover keys in the frontmatter — the exact
  // shape a pre-047 export (or any hand-authored file) would have.
  const file = md(
    { title: "Legacy Post", slug: "legacy-post", type: "article", status: "published" },
    "An old-format post authored before galleries existed.",
  );
  const { source } = sourceFromSingleMarkdown("legacy-post.md", Buffer.from(file));
  const report = await importSource(db, storage, source, "skip");

  expect(report.errorCount).toBe(0);
  expect(report.createdCount).toBe(1);
  const post = await getPostBySlug(db, "legacy-post");
  expect(post).not.toBeNull();
  expect(post!.isGallery).toBe(false);
  expect(post!.gallery).toEqual([]);
  expect(post!.coverMediaId).toBeNull();
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
