import { expect, test } from "bun:test";
import { classifyAndValidate } from "../schema";

test("validates a full post frontmatter shape matching the export contract", () => {
  const result = classifyAndValidate(
    {
      title: "Hello World",
      slug: "hello-world",
      type: "article",
      status: "published",
      tags: [{ name: "Foo", slug: "foo" }],
      publishDate: "2026-01-01T00:00:00.000Z",
      createdAt: "2025-12-01T00:00:00.000Z",
      updatedAt: "2025-12-02T00:00:00.000Z",
      excerpt: "An excerpt.",
      coverImage: { src: "media/abc/800.jpg", alt: "cover" },
      panoramic: false,
      showInBlog: true,
    },
    "body text",
    { directoryKind: "posts", filename: "hello-world.md" },
  );
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.title).toBe("Hello World");
  expect(result.slug).toBe("hello-world");
  expect(result.type).toBe("article");
  expect(result.status).toBe("published");
  expect(result.tags).toEqual([{ name: "Foo", slug: "foo" }]);
  expect(result.publishDate).toBe("2026-01-01T00:00:00.000Z");
  expect(result.createdAt).toBe("2025-12-01T00:00:00.000Z");
  expect(result.coverImage).toEqual({ src: "media/abc/800.jpg", alt: "cover" });
  expect(result.showInBlog).toBe(true);
});

test("validates a page", () => {
  const result = classifyAndValidate(
    { title: "About", slug: "about", type: "page", status: "published", showInNav: true },
    "# About",
    { directoryKind: "pages", filename: "about.md" },
  );
  expect(result.kind).toBe("page");
  if (result.kind !== "page") throw new Error("unreachable");
  expect(result.showInNav).toBe(true);
});

test("loose single-file import with no type field defaults to post/article", () => {
  const result = classifyAndValidate(
    { title: "My Post", slug: "my-post" },
    "body",
    { filename: "my-post.md" },
  );
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.type).toBe("article");
  expect(result.status).toBe("draft");
});

test("loose single-file import with type=page is classified as a page", () => {
  const result = classifyAndValidate({ title: "About", type: "page" }, "body", {
    filename: "about.md",
  });
  expect(result.kind).toBe("page");
});

test("posts/ directory entry whose type disagrees with the directory is a hard error", () => {
  const result = classifyAndValidate(
    { title: "X", slug: "x", type: "page" },
    "body",
    { directoryKind: "posts", filename: "x.md" },
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") throw new Error("unreachable");
  expect(result.reason).toContain("posts/ entry has invalid type");
});

test("pages/ directory entry whose type disagrees with the directory is a hard error", () => {
  const result = classifyAndValidate(
    { title: "X", slug: "x", type: "article" },
    "body",
    { directoryKind: "pages", filename: "x.md" },
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") throw new Error("unreachable");
  expect(result.reason).toContain('pages/ entry has type');
});

test("an unrecognized type field on a loose file is a hard error", () => {
  const result = classifyAndValidate({ title: "X", type: "banana" }, "body", {
    filename: "x.md",
  });
  expect(result.kind).toBe("error");
  if (result.kind !== "error") throw new Error("unreachable");
  expect(result.reason).toContain("unrecognized");
});

test("missing title falls back to a humanized filename", () => {
  const result = classifyAndValidate({}, "body", { filename: "my-cool-post.md" });
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.title).toBe("My Cool Post");
  expect(result.slug).toBe("my-cool-post");
});

test("missing everything except an unusable filename is a hard error", () => {
  const result = classifyAndValidate({}, "body", { filename: "!!!.md" });
  expect(result.kind).toBe("error");
});

test("invalid status is a hard error, not silently defaulted", () => {
  const result = classifyAndValidate(
    { title: "X", slug: "x", status: "archived" },
    "body",
    { filename: "x.md" },
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") throw new Error("unreachable");
  expect(result.reason).toContain("invalid \"status\"");
});

test("malformed coverImage shape is a hard error", () => {
  const result = classifyAndValidate(
    { title: "X", slug: "x", coverImage: "not-an-object" },
    "body",
    { filename: "x.md" },
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") throw new Error("unreachable");
  expect(result.reason).toContain("coverImage");
});

test("a plain-string tags array (common hand-authored shape) is normalized to {name,slug}", () => {
  const result = classifyAndValidate(
    { title: "X", slug: "x", tags: ["Foo Bar", "baz"] },
    "body",
    { filename: "x.md" },
  );
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.tags).toEqual([
    { name: "Foo Bar", slug: "foo-bar" },
    { name: "baz", slug: "baz" },
  ]);
});

test("an unparseable createdAt is lenient — falls back to null rather than failing the item", () => {
  const result = classifyAndValidate(
    { title: "X", slug: "x", createdAt: "not-a-real-date" },
    "body",
    { filename: "x.md" },
  );
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.createdAt).toBeNull();
});

test("panoramic/showInBlog tolerate string 'true'/'false' (lenient boolean coercion)", () => {
  const result = classifyAndValidate(
    { title: "X", slug: "x", panoramic: "true", showInBlog: "false" },
    "body",
    { filename: "x.md" },
  );
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.panoramic).toBe(true);
  expect(result.showInBlog).toBe(false);
});

test("issue 012 — featured coerces leniently and defaults false when absent", () => {
  const set = classifyAndValidate(
    { title: "X", slug: "x", featured: "true" },
    "body",
    { filename: "x.md" },
  );
  if (set.kind !== "post") throw new Error("unreachable");
  expect(set.featured).toBe(true);

  const absent = classifyAndValidate(
    { title: "Y", slug: "y" },
    "body",
    { filename: "y.md" },
  );
  if (absent.kind !== "post") throw new Error("unreachable");
  expect(absent.featured).toBe(false);
});

test("issue 050 — gallery entries are parsed, the media/ prefix stripped to a bare key", () => {
  const result = classifyAndValidate(
    {
      title: "Gallery",
      slug: "gallery",
      isGallery: true,
      gallery: [
        { src: "media/g1/800.jpg", alt: "one", caption: "first" },
        { src: "media/g2/800.jpg", alt: "two", caption: "second" },
      ],
      galleryCover: "media/g2/800.jpg",
    },
    "body",
    { filename: "gallery.md" },
  );
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.isGallery).toBe(true);
  expect(result.gallery).toEqual([
    { key: "g1/800.jpg", alt: "one", caption: "first" },
    { key: "g2/800.jpg", alt: "two", caption: "second" },
  ]);
  expect(result.galleryCoverKey).toBe("g2/800.jpg");
});

test("issue 050 — isGallery/gallery/galleryCover default to false/[]/null when absent (backward compat with pre-gallery archives)", () => {
  const result = classifyAndValidate(
    { title: "Legacy", slug: "legacy" },
    "body",
    { filename: "legacy.md" },
  );
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.isGallery).toBe(false);
  expect(result.gallery).toEqual([]);
  expect(result.galleryCoverKey).toBeNull();
});

test("issue 050 — a malformed individual gallery entry is dropped, not fatal to the whole post", () => {
  const result = classifyAndValidate(
    {
      title: "Gallery",
      slug: "gallery",
      gallery: [
        { src: "media/g1/800.jpg", alt: "ok" },
        "not-an-object",
        { alt: "no src at all" },
        { src: "" },
        42,
      ],
    },
    "body",
    { filename: "gallery.md" },
  );
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.gallery).toEqual([{ key: "g1/800.jpg", alt: "ok", caption: "" }]);
});

test("issue 050 — a gallery entry src with no media/ prefix is kept as a literal key", () => {
  const result = classifyAndValidate(
    { title: "Gallery", slug: "gallery", gallery: [{ src: "bare-key/800.jpg" }] },
    "body",
    { filename: "gallery.md" },
  );
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.gallery).toEqual([{ key: "bare-key/800.jpg", alt: "", caption: "" }]);
});

test("issue 050 — a non-array gallery field normalizes to an empty gallery rather than erroring", () => {
  const result = classifyAndValidate(
    { title: "X", slug: "x", gallery: "not-an-array" },
    "body",
    { filename: "x.md" },
  );
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.gallery).toEqual([]);
});

test("a slug with uppercase or spaces is normalized via slugify, not rejected outright", () => {
  const result = classifyAndValidate(
    { title: "X", slug: "Hello World!" },
    "body",
    { filename: "x.md" },
  );
  expect(result.kind).toBe("post");
  if (result.kind !== "post") throw new Error("unreachable");
  expect(result.slug).toBe("hello-world");
});
