// Gallery photo posts (issue 047) — data-model behavior at the content layer,
// against a real (PGlite) PostgreSQL. Encodes the acceptance criteria:
//   1. A gallery post persists an ORDERED set of media references + per-photo
//      caption; alt is written through to the canonical media row.
//   2. The cover is author-pickable (cover_media_id) and defaults to the first
//      image; coverImage is derived so the index/OG/blog card keep working.
//   3. Reorder changes read-back order; a non-first cover selects that image.
//   4. Single photo posts are UNCHANGED (is_gallery=false, no post_media, cover
//      from cover_image_src) — zero regression.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import {
  createPost,
  getPostBySlug,
  updatePost,
} from "@/lib/content/posts";
import { createMedia, getMediaById } from "@/lib/content/media";
import { checkGalleryMedia } from "@/app/api/admin/photos/posts/_gallery";

// A well-formed UUID that references no media row (for FK-failure / not-found tests).
const ABSENT_UUID = "00000000-0000-4000-8000-000000000000";

let h: TestDb;
beforeEach(async () => {
  h = await createTestDb();
});
afterEach(async () => {
  await h.close();
});

async function seedMedia(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = await createMedia(h.db, {
      storageKey: `img${i}/1200.jpg`,
      alt: `seed alt ${i}`,
      width: 1200,
      height: 800,
      exifStripped: true,
    });
    ids.push(m.id);
  }
  return ids;
}

test("gallery post persists ordered images, captions, and cover; alt writes through", async () => {
  const [a, b, c] = await seedMedia(3);
  const post = await createPost(h.db, {
    title: "Dolomites, June",
    slug: "dolomites-june",
    body: "A week in the mountains.",
    type: "photo-post",
    status: "published",
    publishDate: new Date().toISOString(),
    isGallery: true,
    gallery: [
      { mediaId: a, caption: "Ridge at dawn", alt: "Sunlit ridge" },
      { mediaId: b, caption: "", alt: "Alpine meadow" },
      { mediaId: c, caption: "Refuge", alt: "Stone refuge" },
    ],
  });

  const read = await getPostBySlug(h.db, "dolomites-june");
  expect(read).not.toBeNull();
  expect(read!.isGallery).toBe(true);
  // Ordered by insertion position.
  expect(read!.gallery.map((g) => g.mediaId)).toEqual([a, b, c]);
  expect(read!.gallery.map((g) => g.caption)).toEqual([
    "Ridge at dawn",
    "",
    "Refuge",
  ]);
  // src is the derived public /media/<key> URL.
  expect(read!.gallery[0].src).toBe("/media/img0/1200.jpg");
  // Default cover = first image → coverImage derived from it.
  expect(read!.coverImage).toEqual({
    src: "/media/img0/1200.jpg",
    alt: "Sunlit ridge",
  });
  // Alt written through to the canonical media rows.
  expect((await getMediaById(h.db, a))!.alt).toBe("Sunlit ridge");
  expect((await getMediaById(h.db, b))!.alt).toBe("Alpine meadow");
  // post.id is stable and returned fully populated on create too.
  expect(post.gallery.length).toBe(3);
});

test("reorder changes read-back order; a non-first cover selects that image", async () => {
  const [a, b, c] = await seedMedia(3);
  const post = await createPost(h.db, {
    title: "Trip",
    slug: "trip",
    body: "",
    type: "photo-post",
    status: "published",
    publishDate: new Date().toISOString(),
    isGallery: true,
    gallery: [
      { mediaId: a, alt: "A" },
      { mediaId: b, alt: "B" },
      { mediaId: c, alt: "C" },
    ],
  });

  // Reorder to c, a, b and pick b as the cover.
  await updatePost(h.db, post.id, {
    isGallery: true,
    coverMediaId: b,
    gallery: [
      { mediaId: c, alt: "C" },
      { mediaId: a, alt: "A" },
      { mediaId: b, alt: "B" },
    ],
  });

  const read = await getPostBySlug(h.db, "trip");
  expect(read!.gallery.map((g) => g.mediaId)).toEqual([c, a, b]);
  // Cover is the explicitly chosen (non-first) image.
  expect(read!.coverMediaId).toBe(b);
  expect(read!.coverImage).toEqual({ src: "/media/img1/1200.jpg", alt: "B" });
});

test("removing an image drops only the reference; media survives in the library", async () => {
  const [a, b, c] = await seedMedia(3);
  const post = await createPost(h.db, {
    title: "Prune",
    slug: "prune",
    body: "",
    type: "photo-post",
    status: "published",
    publishDate: new Date().toISOString(),
    isGallery: true,
    gallery: [
      { mediaId: a, alt: "A" },
      { mediaId: b, alt: "B" },
      { mediaId: c, alt: "C" },
    ],
  });
  // Author removes b.
  await updatePost(h.db, post.id, {
    isGallery: true,
    gallery: [
      { mediaId: a, alt: "A" },
      { mediaId: c, alt: "C" },
    ],
  });
  const read = await getPostBySlug(h.db, "prune");
  expect(read!.gallery.map((g) => g.mediaId)).toEqual([a, c]);
  // The removed media row still exists in the library.
  expect(await getMediaById(h.db, b)).not.toBeNull();
});

test("writeGallery is atomic: a mid-write failure rolls back, gallery not corrupted", async () => {
  const [a, b, c] = await seedMedia(3);
  const post = await createPost(h.db, {
    title: "Atomic",
    slug: "atomic",
    body: "",
    type: "photo-post",
    status: "published",
    publishDate: new Date().toISOString(),
    isGallery: true,
    gallery: [
      { mediaId: a, alt: "A" },
      { mediaId: b, alt: "B" },
      { mediaId: c, alt: "C" },
    ],
  });

  // Rewrite with a nonexistent media id in the middle → the INSERT hits the FK
  // and throws. The whole DELETE+INSERT unit must roll back (all-or-nothing).
  await expect(
    updatePost(h.db, post.id, {
      isGallery: true,
      gallery: [
        { mediaId: a, alt: "A" },
        { mediaId: ABSENT_UUID, alt: "ghost" },
        { mediaId: c, alt: "C" },
      ],
    }),
  ).rejects.toThrow();

  // The original membership is intact — not half-written, not emptied.
  const read = await getPostBySlug(h.db, "atomic");
  expect(read!.gallery.map((g) => g.mediaId)).toEqual([a, b, c]);
});

test("switching a post out of gallery mode clears orphaned post_media rows", async () => {
  const [a, b] = await seedMedia(2);
  const post = await createPost(h.db, {
    title: "Switcheroo",
    slug: "switcheroo",
    body: "",
    type: "photo-post",
    status: "draft",
    isGallery: true,
    coverMediaId: b,
    gallery: [
      { mediaId: a, alt: "A" },
      { mediaId: b, alt: "B" },
    ],
  });
  // Switch to Single (isGallery:false, cover nulled) — the membership must go.
  await updatePost(h.db, post.id, { isGallery: false, coverMediaId: null });

  const read = await getPostBySlug(h.db, "switcheroo");
  expect(read!.isGallery).toBe(false);
  expect(read!.gallery).toEqual([]); // no orphaned post_media rows
  expect(read!.coverMediaId).toBeNull();
  // The media rows themselves survive in the library.
  expect(await getMediaById(h.db, a)).not.toBeNull();
});

test("checkGalleryMedia rejects nonexistent / malformed ids, maps stored alts", async () => {
  const [a, b] = await seedMedia(2);
  // Valid → no error, stored alts returned.
  const ok = await checkGalleryMedia(h.db, [
    { mediaId: a, alt: "x" },
    { mediaId: b },
  ]);
  expect(ok.error).toBeNull();
  expect(ok.storedAlt.get(a)).toBe("seed alt 0");
  expect(ok.storedAlt.get(b)).toBe("seed alt 1");
  // Nonexistent UUID → clean error (would otherwise FK-500 mid-write).
  const missing = await checkGalleryMedia(h.db, [{ mediaId: ABSENT_UUID }]);
  expect(missing.error).not.toBeNull();
  // Malformed (non-UUID) id → error, never a cast crash.
  const malformed = await checkGalleryMedia(h.db, [{ mediaId: "not-a-uuid" }]);
  expect(malformed.error).not.toBeNull();
});

test("single photo post is unchanged: no gallery, cover from cover_image_src", async () => {
  await createPost(h.db, {
    title: "One shot",
    slug: "one-shot",
    body: "",
    type: "photo-post",
    status: "published",
    publishDate: new Date().toISOString(),
    coverImage: { src: "/media/solo/1200.jpg", alt: "A single photo" },
  });
  const read = await getPostBySlug(h.db, "one-shot");
  expect(read!.isGallery).toBe(false);
  expect(read!.gallery).toEqual([]);
  expect(read!.coverMediaId).toBeNull();
  expect(read!.coverImage).toEqual({
    src: "/media/solo/1200.jpg",
    alt: "A single photo",
  });
});
