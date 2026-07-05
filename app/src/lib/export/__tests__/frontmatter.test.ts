import { expect, test } from "bun:test";
import {
  pageFrontmatterFields,
  postFrontmatterFields,
  serializeMarkdownFile,
} from "../frontmatter";
import type { Page, Post } from "@/lib/content/types";

// Parses the fenced-frontmatter shape serializeMarkdownFile() produces, using
// only the JSON-subset trick documented in frontmatter.ts (no yaml dependency
// needed here either — every value is a JSON.stringify() literal).
function parseFrontmatter(text: string): {
  fields: Record<string, unknown>;
  body: string;
} {
  const lines = text.split("\n");
  expect(lines[0]).toBe("---");
  const closeIdx = lines.indexOf("---", 1);
  expect(closeIdx).toBeGreaterThan(0);
  const fields: Record<string, unknown> = {};
  for (const line of lines.slice(1, closeIdx)) {
    const idx = line.indexOf(": ");
    const key = line.slice(0, idx);
    fields[key] = JSON.parse(line.slice(idx + 2));
  }
  // body starts after the closing fence + one blank line
  const body = lines.slice(closeIdx + 2).join("\n").replace(/\n$/, "");
  return { fields, body };
}

const post: Post = {
  id: "p1",
  title: "Hello, \"World\"",
  slug: "hello-world",
  body: "# Hi\n\nSome text.",
  excerpt: "An intro",
  coverImage: { src: "/media/abc/800.jpg", alt: "a cover" },
  type: "article",
  panoramic: false,
  showInBlog: true,
  featured: true,
  isGallery: false,
  coverMediaId: null,
  gallery: [],
  status: "published",
  publishDate: "2026-06-01T00:00:00.000Z",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  tags: [
    { id: "t1", name: "Docker", slug: "docker" },
    { id: "t2", name: "Linux", slug: "linux" },
  ],
};

test("postFrontmatterFields + serializeMarkdownFile round-trip every field", () => {
  const text = serializeMarkdownFile(postFrontmatterFields(post), post.body);
  const { fields, body } = parseFrontmatter(text);

  expect(fields.title).toBe(post.title);
  expect(fields.slug).toBe(post.slug);
  expect(fields.type).toBe("article");
  expect(fields.status).toBe("published");
  expect(fields.tags).toEqual([
    { name: "Docker", slug: "docker" },
    { name: "Linux", slug: "linux" },
  ]);
  expect(fields.publishDate).toBe(post.publishDate);
  expect(fields.createdAt).toBe(post.createdAt);
  expect(fields.updatedAt).toBe(post.updatedAt);
  expect(fields.excerpt).toBe(post.excerpt);
  expect(fields.coverImage).toEqual(post.coverImage);
  expect(fields.panoramic).toBe(false);
  expect(fields.showInBlog).toBe(true);
  expect(fields.featured).toBe(true);
  expect(fields.isGallery).toBe(false);
  expect(fields.gallery).toEqual([]);
  expect(fields.galleryCover).toBeNull();
  expect(body).toBe(post.body);
});

test("issue 050 — gallery membership + explicit cover choice are emitted as portable, media-key-based fields", () => {
  const gallery: Post = {
    ...post,
    isGallery: true,
    coverMediaId: "media-2",
    gallery: [
      { mediaId: "media-1", src: "/media/g1/800.jpg", alt: "first", caption: "one", width: 800, height: 600 },
      { mediaId: "media-2", src: "/media/g2/800.jpg", alt: "second", caption: "two", width: 800, height: 600 },
    ],
  };
  // The caller (exporter.ts) is responsible for resolving coverMediaId into an
  // archive-relative media key before calling this function — see
  // postFrontmatterFields's doc comment. Here that's the second entry's key.
  const { fields } = parseFrontmatter(
    serializeMarkdownFile(postFrontmatterFields(gallery, "media/g2/800.jpg"), gallery.body),
  );
  expect(fields.isGallery).toBe(true);
  expect(fields.gallery).toEqual([
    { src: "/media/g1/800.jpg", alt: "first", caption: "one" },
    { src: "/media/g2/800.jpg", alt: "second", caption: "two" },
  ]);
  expect(fields.galleryCover).toBe("media/g2/800.jpg");
});

test("post frontmatter always emits every field, even null/false (lossless shape)", () => {
  const draft: Post = { ...post, coverImage: null, publishDate: null, panoramic: false };
  const { fields } = parseFrontmatter(
    serializeMarkdownFile(postFrontmatterFields(draft), draft.body),
  );
  expect(Object.prototype.hasOwnProperty.call(fields, "coverImage")).toBe(true);
  expect(fields.coverImage).toBeNull();
  expect(Object.prototype.hasOwnProperty.call(fields, "publishDate")).toBe(true);
  expect(fields.publishDate).toBeNull();
});

const page: Page = {
  id: "pg1",
  title: "About",
  slug: "about",
  body: "# About me",
  status: "draft",
  showInNav: true,
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

test("pageFrontmatterFields emits the synthetic type: page discriminator", () => {
  const { fields, body } = parseFrontmatter(
    serializeMarkdownFile(pageFrontmatterFields(page), page.body),
  );
  expect(fields.type).toBe("page");
  expect(fields.title).toBe("About");
  expect(fields.slug).toBe("about");
  expect(fields.status).toBe("draft");
  expect(fields.showInNav).toBe(true);
  expect(body).toBe(page.body);
});

test("special characters (quotes, unicode, newlines-in-title) survive the JSON-subset encoding", () => {
  const weird: Post = {
    ...post,
    title: 'Quote " and back\\slash and emoji \u{1F600}',
    excerpt: "line one\nline two",
  };
  const { fields } = parseFrontmatter(
    serializeMarkdownFile(postFrontmatterFields(weird), weird.body),
  );
  expect(fields.title).toBe(weird.title);
  expect(fields.excerpt).toBe(weird.excerpt);
});
