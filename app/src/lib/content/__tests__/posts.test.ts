import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import {
  createPost,
  deletePost,
  getPostBySlug,
  getPublishedPostBySlug,
  listPosts,
  listPublishedPosts,
  listPublishedFeatured,
  updatePost,
} from "../posts";

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("round-trips a post with cover image and tags", async () => {
  const created = await createPost(db, {
    title: "Hello Docker",
    slug: "hello-docker",
    body: "# Body markdown",
    excerpt: "An intro",
    coverImage: { src: "media/cover.jpg", alt: "a cover" },
    type: "article",
    status: "published",
    publishDate: "2026-06-01T00:00:00.000Z",
    tags: [
      { name: "Docker", slug: "docker" },
      { name: "Linux", slug: "linux" },
    ],
  });

  const fetched = await getPostBySlug(db, "hello-docker");
  expect(fetched).not.toBeNull();
  expect(fetched!.id).toBe(created.id);
  expect(fetched!.title).toBe("Hello Docker");
  expect(fetched!.body).toBe("# Body markdown");
  expect(fetched!.coverImage).toEqual({ src: "media/cover.jpg", alt: "a cover" });
  expect(fetched!.publishDate).toBe("2026-06-01T00:00:00.000Z");
  expect(fetched!.tags.map((t) => t.slug).sort()).toEqual(["docker", "linux"]);
});

test("published-only reads exclude draft AND future-scheduled posts", async () => {
  await createPost(db, {
    title: "Published",
    slug: "published",
    body: "x",
    status: "published",
    publishDate: "2026-06-01T00:00:00.000Z",
  });
  await createPost(db, { title: "Draft", slug: "draft", body: "x", status: "draft" });
  await createPost(db, {
    title: "Scheduled",
    slug: "scheduled",
    body: "x",
    status: "scheduled",
    publishDate: "2099-01-01T00:00:00.000Z", // far future → still hidden
  });

  // Admin sees all three; theme materialization sees only the published one.
  expect((await listPosts(db)).length).toBe(3);

  const visible = await listPublishedPosts(db);
  expect(visible.map((p) => p.slug)).toEqual(["published"]);

  // A draft is unreachable through the published-only by-slug read.
  expect(await getPublishedPostBySlug(db, "draft")).toBeNull();
  // A future-scheduled post stays hidden until its time.
  expect(await getPublishedPostBySlug(db, "scheduled")).toBeNull();
  expect(await getPublishedPostBySlug(db, "published")).not.toBeNull();
});

test("scheduled post with past publish_date is visible; future stays hidden", async () => {
  // Past-dated scheduled post → auto-reveals (scheduled publishing).
  await createPost(db, {
    title: "Past-Scheduled",
    slug: "past-scheduled",
    body: "x",
    status: "scheduled",
    publishDate: "2020-01-01T00:00:00.000Z", // in the past → visible now
  });
  // Future-dated scheduled post → hidden until that time.
  await createPost(db, {
    title: "Future-Scheduled",
    slug: "future-scheduled",
    body: "x",
    status: "scheduled",
    publishDate: "2099-01-01T00:00:00.000Z", // far future → still hidden
  });

  // Past-scheduled auto-reveals to the theme.
  expect(await getPublishedPostBySlug(db, "past-scheduled")).not.toBeNull();
  // Future-scheduled stays hidden.
  expect(await getPublishedPostBySlug(db, "future-scheduled")).toBeNull();

  // listPublishedPosts includes past-scheduled, excludes future-scheduled.
  const visible = await listPublishedPosts(db);
  const slugs = visible.map((p) => p.slug);
  expect(slugs).toContain("past-scheduled");
  expect(slugs).not.toContain("future-scheduled");
});

test("publishing a draft makes it reachable by the theme; unpublishing hides it", async () => {
  const post = await createPost(db, {
    title: "WIP",
    slug: "wip",
    body: "x",
    status: "draft",
  });
  expect(await getPublishedPostBySlug(db, "wip")).toBeNull();

  await updatePost(db, post.id, {
    status: "published",
    publishDate: "2026-06-02T00:00:00.000Z",
  });
  expect(await getPublishedPostBySlug(db, "wip")).not.toBeNull();

  await updatePost(db, post.id, { status: "draft" });
  expect(await getPublishedPostBySlug(db, "wip")).toBeNull();
});

test("updatePost replaces the tag set and deletePost removes the row", async () => {
  const post = await createPost(db, {
    title: "Taggable",
    slug: "taggable",
    body: "x",
    tags: [{ name: "Old", slug: "old" }],
  });
  await updatePost(db, post.id, { tags: [{ name: "New", slug: "new" }] });
  const after = await getPostBySlug(db, "taggable");
  expect(after!.tags.map((t) => t.slug)).toEqual(["new"]);

  expect(await deletePost(db, post.id)).toBe(true);
  expect(await getPostBySlug(db, "taggable")).toBeNull();
});

test("listPublishedPosts filters by tag slug", async () => {
  await createPost(db, {
    title: "A",
    slug: "a",
    body: "x",
    status: "published",
    publishDate: "2026-06-01T00:00:00.000Z",
    tags: [{ name: "Travel", slug: "travel" }],
  });
  await createPost(db, {
    title: "B",
    slug: "b",
    body: "x",
    status: "published",
    publishDate: "2026-06-02T00:00:00.000Z",
    tags: [{ name: "Linux", slug: "linux" }],
  });

  const travel = await listPublishedPosts(db, { tagSlug: "travel" });
  expect(travel.map((p) => p.slug)).toEqual(["a"]);
});

test("the status CHECK constraint rejects an invalid status", async () => {
  await expect(
    db.query(
      `INSERT INTO posts (title, slug, body, status) VALUES ('x','x','x','bogus')`,
    ),
  ).rejects.toThrow();
});

// ── show_in_blog / blogStream tests ──────────────────────────────────────────

test("photo-post showInBlog defaults false on create", async () => {
  const post = await createPost(db, {
    title: "Sunrise",
    slug: "sunrise",
    body: "x",
    type: "photo-post",
    status: "published",
    publishDate: "2026-06-01T00:00:00.000Z",
  });
  expect(post.showInBlog).toBe(false);
});

test("showInBlog persists when set true on create", async () => {
  const post = await createPost(db, {
    title: "Opted-In Photo",
    slug: "opted-in-photo",
    body: "x",
    type: "photo-post",
    status: "published",
    publishDate: "2026-06-01T00:00:00.000Z",
    showInBlog: true,
  });
  expect(post.showInBlog).toBe(true);
});

test("updatePost persists showInBlog toggle", async () => {
  const post = await createPost(db, {
    title: "Toggle Test",
    slug: "toggle-test",
    body: "x",
    type: "photo-post",
    status: "published",
    publishDate: "2026-06-01T00:00:00.000Z",
    showInBlog: false,
  });
  expect(post.showInBlog).toBe(false);

  const updated = await updatePost(db, post.id, { showInBlog: true });
  expect(updated?.showInBlog).toBe(true);

  const toggledOff = await updatePost(db, post.id, { showInBlog: false });
  expect(toggledOff?.showInBlog).toBe(false);
});

test("listPublishedPosts with blogStream:true excludes photo-posts with showInBlog=false", async () => {
  await createPost(db, {
    title: "Article One",
    slug: "article-one",
    body: "x",
    type: "article",
    status: "published",
    publishDate: "2026-06-01T00:00:00.000Z",
  });
  await createPost(db, {
    title: "Photo No Blog",
    slug: "photo-no-blog",
    body: "x",
    type: "photo-post",
    status: "published",
    publishDate: "2026-06-02T00:00:00.000Z",
    showInBlog: false, // default — must be absent from blog stream
  });

  const stream = await listPublishedPosts(db, { blogStream: true });
  const slugs = stream.map((p) => p.slug);
  expect(slugs).toContain("article-one");
  expect(slugs).not.toContain("photo-no-blog");
});

test("listPublishedPosts with blogStream:true includes photo-posts with showInBlog=true", async () => {
  await createPost(db, {
    title: "Article One",
    slug: "article-one",
    body: "x",
    type: "article",
    status: "published",
    publishDate: "2026-06-01T00:00:00.000Z",
  });
  await createPost(db, {
    title: "Photo In Blog",
    slug: "photo-in-blog",
    body: "x",
    type: "photo-post",
    status: "published",
    publishDate: "2026-06-02T00:00:00.000Z",
    showInBlog: true,
  });

  const stream = await listPublishedPosts(db, { blogStream: true });
  const slugs = stream.map((p) => p.slug);
  expect(slugs).toContain("article-one");
  expect(slugs).toContain("photo-in-blog");
});

test("listPublishedPosts without blogStream includes ALL photo-posts (photos grid)", async () => {
  await createPost(db, {
    title: "Photo No Blog",
    slug: "photo-no-blog",
    body: "x",
    type: "photo-post",
    status: "published",
    publishDate: "2026-06-01T00:00:00.000Z",
    showInBlog: false,
  });
  await createPost(db, {
    title: "Photo In Blog",
    slug: "photo-in-blog",
    body: "x",
    type: "photo-post",
    status: "published",
    publishDate: "2026-06-02T00:00:00.000Z",
    showInBlog: true,
  });

  // No blogStream filter: both photo-posts visible (photos grid sees all).
  const all = await listPublishedPosts(db, { type: "photo-post" });
  const slugs = all.map((p) => p.slug);
  expect(slugs).toContain("photo-no-blog");
  expect(slugs).toContain("photo-in-blog");
});

// ── Issue 012 — featured flag + listPublishedFeatured ───────────────────────

test("featured defaults false on create and round-trips through create/update", async () => {
  const created = await createPost(db, {
    title: "F", slug: "f", body: "x", status: "published",
  });
  expect(created.featured).toBe(false); // default

  const withFlag = await createPost(db, {
    title: "G", slug: "g", body: "x", status: "published", featured: true,
  });
  expect(withFlag.featured).toBe(true);

  const toggledOff = await updatePost(db, withFlag.id, { featured: false });
  expect(toggledOff!.featured).toBe(false);
  const toggledOn = await updatePost(db, created.id, { featured: true });
  expect(toggledOn!.featured).toBe(true);
});

test("listPublishedFeatured returns only featured, published posts of any type, newest-first", async () => {
  await createPost(db, { title: "Feat Art", slug: "fa", body: "x", type: "article", status: "published", featured: true, publishDate: "2026-05-01T00:00:00.000Z" });
  await createPost(db, { title: "Feat Photo", slug: "fp", body: "", type: "photo-post", status: "published", featured: true, publishDate: "2026-06-01T00:00:00.000Z" });
  await createPost(db, { title: "Plain", slug: "pl", body: "x", status: "published", featured: false, publishDate: "2026-07-01T00:00:00.000Z" });
  await createPost(db, { title: "Feat Draft", slug: "fd", body: "x", status: "draft", featured: true });

  const featured = await listPublishedFeatured(db);
  expect(featured.map((p) => p.slug)).toEqual(["fp", "fa"]); // newest-first; plain + draft excluded
});
