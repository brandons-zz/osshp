// Issue 051 — blog-route cross-type guard.
//
// The blog PATCH/DELETE routes must refuse any row that is not `type:'article'`.
// Before this fix, PATCH /api/admin/blog/posts/<id> {status:"published"} had no
// post-type restriction: a draft photo/gallery post created via the photos
// route (legitimately exempt from the alt gate while draft) could be
// status-flipped to published through the BLOG route, bypassing the photos
// route's publish-time alt gate (issue 047's effectivePublishAltError) — the
// blog route runs no gallery-alt validation of its own.
//
// `isBlogArticle` is the guard both PATCH and DELETE now check before touching
// the store. It is tested here at the decision-logic level (mirrors
// `_gallery.ts` / `gallery-validate.test.ts`) plus against a REAL row created
// via `createPost` against a PGlite DB, so the exact issue-051 repro shape (a
// draft gallery with an empty-alt image) is proven refused. A full HTTP-level
// route test would need `getDb()` wired to the test DB; this codebase's
// documented convention avoids `mock.module` for that because bun:test shares
// a module registry across test files and a mocked `@/lib/db/client` would
// leak into unrelated test files (see recovery-login-routes.test.ts).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import { createPost, getPostById } from "@/lib/content/posts";
import { createMedia } from "@/lib/content/media";
import { isBlogArticle } from "../_type-guard";

let h: TestDb;
beforeEach(async () => {
  h = await createTestDb();
});
afterEach(async () => {
  await h.close();
});

test("isBlogArticle: an article passes; missing (null) is refused", () => {
  expect(isBlogArticle({ type: "article" })).toBe(true);
  expect(isBlogArticle(null)).toBe(false);
});

test("isBlogArticle: a photo-post is refused, gallery or not", () => {
  expect(isBlogArticle({ type: "photo-post" })).toBe(false);
});

test("issue-051 repro: a draft gallery with a missing-alt image fails the blog route's guard", async () => {
  const media = await createMedia(h.db, {
    storageKey: "photos/a.jpg",
    alt: "", // missing alt — legitimately exempt while draft (issue 047)
    width: 100,
    height: 100,
    exifStripped: true,
  });
  const gallery = await createPost(h.db, {
    title: "Untitled gallery",
    slug: "untitled-gallery-051",
    body: "",
    type: "photo-post",
    status: "draft",
    isGallery: true,
    gallery: [{ mediaId: media.id, alt: "" }],
  });

  // Before the fix, PATCH /api/admin/blog/posts/<id> {status:"published"} had
  // no type restriction and would have called updatePost() unconditionally —
  // publishing this missing-alt gallery with no alt-gate check at all. The
  // route now fetches the row and refuses it via isBlogArticle() first.
  const fetched = await getPostById(h.db, gallery.id);
  expect(fetched?.type).toBe("photo-post");
  expect(isBlogArticle(fetched)).toBe(false);
});

test("a real article row passes the blog route's guard (AC3 — articles unaffected)", async () => {
  const article = await createPost(h.db, {
    title: "A real article",
    slug: "a-real-article-051",
    body: "hello",
    type: "article",
    status: "draft",
  });
  const fetched = await getPostById(h.db, article.id);
  expect(isBlogArticle(fetched)).toBe(true);
});

test("a published gallery (already through the alt gate) is still refused by the blog route", async () => {
  const media = await createMedia(h.db, {
    storageKey: "photos/b.jpg",
    alt: "a fully described photograph",
    width: 100,
    height: 100,
    exifStripped: true,
  });
  const gallery = await createPost(h.db, {
    title: "Published gallery",
    slug: "published-gallery-051",
    body: "",
    type: "photo-post",
    status: "published",
    publishDate: new Date().toISOString(),
    isGallery: true,
    gallery: [{ mediaId: media.id, alt: "a fully described photograph" }],
  });
  const fetched = await getPostById(h.db, gallery.id);
  // Publishing is impossible from ANY admin route means: even an already
  // fully-alt-texted gallery must never be reachable via the blog route at
  // all — the photos route is the only route allowed to touch this type.
  expect(isBlogArticle(fetched)).toBe(false);
});
