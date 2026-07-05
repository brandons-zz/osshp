// Media usage scan (issue 037 §5; key-shape fix issue 039). The one helper set
// behind list counts, the where-used panel, the delete gate, the replace
// reference-rewrite, and the force-delete reference cleanup.
//
// Matching is on the media's EXACT reference URLs (primary + variant siblings),
// never a "first path segment" prefix — that is the whole point of 039.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createPost, getPostById } from "@/lib/content/posts";
import { createPage, getPageById } from "@/lib/content/pages";
import { createMedia } from "@/lib/content/media";
import {
  findUsageInContent,
  findMediaUsage,
  rewriteMediaReferences,
  stripMediaReferences,
  mediaReferenceUrls,
  type ScanContent,
} from "../media-usage";

let h: TestDb;
let db: Db;
beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

// The reference anchor is the storage KEY (what the /media/<key> URL carries),
// distinct from media.id. UUID stand-ins for pipeline storage prefixes.
const ID = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

// ── mediaReferenceUrls — exact URL set per key shape (issue 039) ──────────────

test("mediaReferenceUrls: pipeline key → primary + variant-sibling URLs", () => {
  const urls = mediaReferenceUrls({
    storageKey: `${ID}/1600.jpg`,
    responsiveSizes: [
      { key: `${ID}/400.jpg` },
      { key: `${ID}/800.jpg` },
      { key: `${ID}/1600.jpg` },
    ],
  });
  expect(urls.sort()).toEqual([
    `/media/${ID}/1600.jpg`,
    `/media/${ID}/400.jpg`,
    `/media/${ID}/800.jpg`,
  ].sort());
});

test("mediaReferenceUrls: flat key → its exact URL, NO trailing-slash anchor", () => {
  const urls = mediaReferenceUrls({ storageKey: "foo.png", responsiveSizes: [] });
  expect(urls).toEqual(["/media/foo.png"]);
  // The old prefix logic produced "/media/foo.png/" which never matches.
  expect(urls).not.toContain("/media/foo.png/");
});

test("issue 039: two imported media sharing a 'migrated' first segment do NOT conflate", () => {
  const a = mediaReferenceUrls({ storageKey: "migrated/a.jpg", responsiveSizes: [] });
  const b = mediaReferenceUrls({ storageKey: "migrated/b.jpg", responsiveSizes: [] });
  const content: ScanContent = {
    posts: [
      {
        id: "pa",
        type: "article",
        title: "uses A",
        slug: "a",
        cover_image_src: "/media/migrated/a.jpg",
        body: "",
      },
      {
        id: "pb",
        type: "article",
        title: "uses B",
        slug: "b",
        cover_image_src: "/media/migrated/b.jpg",
        body: "",
      },
    ],
    pages: [],
  };
  // Each media matches ONLY its own referencing post — not both.
  expect(findUsageInContent(content, a).map((u) => u.id)).toEqual(["pa"]);
  expect(findUsageInContent(content, b).map((u) => u.id)).toEqual(["pb"]);
});

test("issue 039: a flat-key image that IS in use is not reported as unused", () => {
  const urls = mediaReferenceUrls({ storageKey: "logo.png", responsiveSizes: [] });
  const content: ScanContent = {
    posts: [
      {
        id: "p1",
        type: "article",
        title: "hero",
        slug: "hero",
        cover_image_src: "/media/logo.png",
        body: "",
      },
    ],
    pages: [],
  };
  expect(findUsageInContent(content, urls).length).toBe(1); // NOT 0 → delete-safe
});

// ── findUsageInContent — one row per item, cover preferred ────────────────────

test("findUsageInContent (pure): one row per content item, cover preferred", () => {
  const urls = mediaReferenceUrls({
    storageKey: `${ID}/1600.jpg`,
    responsiveSizes: [
      { key: `${ID}/400.jpg` },
      { key: `${ID}/800.jpg` },
      { key: `${ID}/1600.jpg` },
    ],
  });
  const content: ScanContent = {
    posts: [
      {
        id: "p1",
        type: "article",
        title: "Cover + body",
        slug: "cover-body",
        cover_image_src: `/media/${ID}/1600.jpg`,
        body: `text ![x](/media/${ID}/800.jpg) more`,
      },
      {
        id: "p2",
        type: "photo-post",
        title: "Body only",
        slug: "body-only",
        cover_image_src: null,
        body: `![x](/media/${ID}/400.jpg)`,
      },
      {
        id: "p3",
        type: "article",
        title: "Unrelated",
        slug: "unrelated",
        cover_image_src: `/media/${OTHER}/1600.jpg`,
        body: "no image",
      },
    ],
    pages: [
      { id: "pg1", title: "About", slug: "about", body: `![x](/media/${ID}/800.jpg)` },
    ],
  };
  const usage = findUsageInContent(content, urls);
  expect(usage.length).toBe(3);
  expect(usage.find((u) => u.id === "p1")?.field).toBe("cover");
  expect(usage.find((u) => u.id === "p1")?.adminHref).toBe("/admin/blog/p1/edit");
  expect(usage.find((u) => u.id === "p2")?.field).toBe("body");
  expect(usage.find((u) => u.id === "p2")?.adminHref).toBe("/admin/photos/p2/edit");
  expect(usage.find((u) => u.id === "pg1")?.type).toBe("page");
});

// ── findMediaUsage (DB) ───────────────────────────────────────────────────────

test("findMediaUsage (DB): a post referencing the media surfaces in usage", async () => {
  const media = await createMedia(db, {
    storageKey: `${ID}/800.jpg`,
    responsiveSizes: [{ width: 800, height: 600, key: `${ID}/800.jpg` }],
  });
  expect(media.id).not.toBe(ID); // media.id ≠ storage key

  const post = await createPost(db, {
    title: "Trip",
    slug: "trip",
    body: `Look:\n\n![a boat](/media/${ID}/800.jpg)\n`,
    type: "article",
    status: "published",
  });
  await createPost(db, {
    title: "Nothing",
    slug: "nothing",
    body: "no media here",
    type: "article",
    status: "draft",
  });

  const usage = await findMediaUsage(db, media.id);
  expect(usage.length).toBe(1);
  expect(usage[0].id).toBe(post.id);
  expect(usage[0].field).toBe("body");
});

test("findMediaUsage (DB): unknown media id returns empty", async () => {
  const usage = await findMediaUsage(db, "00000000-0000-0000-0000-000000000000");
  expect(usage).toEqual([]);
});

// ── rewriteMediaReferences (replace) ──────────────────────────────────────────

test("rewriteMediaReferences re-points cover + any-variant body to the new URL", async () => {
  const oldPrimary = `/media/${ID}/1600.jpg`;
  const oldVariant = `/media/${ID}/800.jpg`; // a body embed of a NON-primary variant
  const newUrl = `/media/${ID}/1200.jpg`;

  const post = await createPost(db, {
    title: "Has cover + body",
    slug: "has-cover",
    body: `intro ![x](${oldVariant}) end`,
    coverImage: { src: oldPrimary, alt: "cover" },
    type: "article",
    status: "published",
  });
  const page = await createPage(db, {
    title: "Page",
    slug: "page",
    body: `![x](${oldPrimary})`,
    status: "published",
  });

  const changed = await rewriteMediaReferences(
    db,
    [oldPrimary, oldVariant],
    newUrl,
  );
  expect(changed).toBeGreaterThanOrEqual(3);

  const updatedPost = await getPostById(db, post.id);
  expect(updatedPost?.coverImage?.src).toBe(newUrl);
  expect(updatedPost?.body).toContain(newUrl);
  expect(updatedPost?.body).not.toContain(oldVariant); // non-primary re-pointed too

  const updatedPage = await getPageById(db, page.id);
  expect(updatedPage?.body).toBe(`![x](${newUrl})`);
});

test("rewriteMediaReferences skips URLs equal to the new URL", async () => {
  const url = `/media/${ID}/800.jpg`;
  await createPost(db, {
    title: "P",
    slug: "p",
    body: `![x](${url})`,
    type: "article",
    status: "draft",
  });
  expect(await rewriteMediaReferences(db, [url], url)).toBe(0);
});

// ── stripMediaReferences (force-delete cleanup — QA finding 1) ─────────────────

test("stripMediaReferences clears matching covers and removes body images", async () => {
  const primary = `/media/${ID}/1600.jpg`;
  const variant = `/media/${ID}/800.jpg`;
  const urls = mediaReferenceUrls({
    storageKey: `${ID}/1600.jpg`,
    responsiveSizes: [{ key: `${ID}/800.jpg` }, { key: `${ID}/1600.jpg` }],
  });

  const coverPost = await createPost(db, {
    title: "Cover user",
    slug: "cover-user",
    body: "no image in body",
    coverImage: { src: primary, alt: "cover alt" },
    type: "article",
    status: "published",
  });
  const bodyPost = await createPost(db, {
    title: "Body user",
    slug: "body-user",
    body: `before\n\n![a caption](${variant})\n\nafter`,
    type: "article",
    status: "published",
  });
  const bodyPage = await createPage(db, {
    title: "Page user",
    slug: "page-user",
    body: `intro ![x](${primary}) outro`,
    status: "published",
  });
  const untouched = await createPost(db, {
    title: "Untouched",
    slug: "untouched",
    body: `![other](/media/${OTHER}/800.jpg)`,
    type: "article",
    status: "published",
  });

  const changed = await stripMediaReferences(db, urls);
  expect(changed).toBe(3);

  // Cover cleared.
  const p1 = await getPostById(db, coverPost.id);
  expect(p1?.coverImage).toBeNull();

  // Body image removed — no dangling reference to the deleted media remains.
  const p2 = await getPostById(db, bodyPost.id);
  expect(p2?.body).not.toContain(variant);
  expect(p2?.body).toContain("before");
  expect(p2?.body).toContain("after");

  const pg = await getPageById(db, bodyPage.id);
  expect(pg?.body).not.toContain(primary);

  // An image belonging to a DIFFERENT media is left alone.
  const u = await getPostById(db, untouched.id);
  expect(u?.body).toContain(`/media/${OTHER}/800.jpg`);
});

test("stripMediaReferences is a no-op for an unused media", async () => {
  await createPost(db, {
    title: "P",
    slug: "p",
    body: "plain",
    type: "article",
    status: "draft",
  });
  const changed = await stripMediaReferences(db, [`/media/${ID}/1600.jpg`]);
  expect(changed).toBe(0);
});
