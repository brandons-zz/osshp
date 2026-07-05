// Issue 071 (Finding 2) — photos-route cross-type guard.
//
// The photos PATCH route unconditionally forced `type: "photo-post"` on write
// but never checked what the row being edited WAS beforehand — contrast with
// the blog route's `isBlogArticle` guard (issue 051). Before this fix, an
// existing `article` row's id could be PATCHed through
// `/api/admin/photos/posts/<id>` and be silently converted in place into a
// gallery photo-post: never created through the photos route's own path, and
// regardless of the Blog module's enablement state (the photos route's gate
// only ever consulted Photos).
//
// `isPhotoPost` is the guard the PATCH route now checks before touching the
// store. Tested here at the decision-logic level (mirrors the blog route's
// `../../../blog/posts/__tests__/type-guard.test.ts`) plus against a REAL row
// created via `createPost` against a PGlite DB, proving the issue-071 repro
// shape (an existing article) is refused.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import { createPost, getPostById } from "@/lib/content/posts";
import { isPhotoPost } from "../_type-guard";

let h: TestDb;
beforeEach(async () => {
  h = await createTestDb();
});
afterEach(async () => {
  await h.close();
});

test("isPhotoPost: a photo-post passes; missing (null) is refused", () => {
  expect(isPhotoPost({ type: "photo-post" })).toBe(true);
  expect(isPhotoPost(null)).toBe(false);
});

test("isPhotoPost: an article is refused", () => {
  expect(isPhotoPost({ type: "article" })).toBe(false);
});

test("issue-071 repro: an existing article row fails the photos route's guard", async () => {
  const article = await createPost(h.db, {
    title: "A real article",
    slug: "a-real-article-071",
    body: "hello",
    type: "article",
    status: "draft",
  });

  // Before the fix, PATCH /api/admin/photos/posts/<article-id> had no
  // type restriction and would have called updatePost() unconditionally with
  // type:"photo-post" — silently converting the article in place. The route
  // now fetches the row and refuses it via isPhotoPost() first.
  const fetched = await getPostById(h.db, article.id);
  expect(fetched?.type).toBe("article");
  expect(isPhotoPost(fetched)).toBe(false);
});

test("a real photo-post row passes the photos route's guard (unaffected)", async () => {
  const photoPost = await createPost(h.db, {
    title: "A real photo post",
    slug: "a-real-photo-post-071",
    body: "",
    type: "photo-post",
    status: "draft",
  });
  const fetched = await getPostById(h.db, photoPost.id);
  expect(isPhotoPost(fetched)).toBe(true);
});
