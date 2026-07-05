// Usage-aware media deletion (issues 056 + 057). Proves the gate + cleanup that
// the single delete, the bulk delete, and the photo-post media cleanup all share:
//   - an unused image deletes (objects + row gone);
//   - a referenced image is blocked without force, removed (refs stripped) with it;
//   - GALLERY membership counts as "in use" (issue 047 post_media is a JOIN, not
//     embedded text — the pure content scan can't see it);
//   - deleting a photo post can also delete its owned photos, KEEPING any shared
//     with another post (never silently orphaned);
//   - bulk delete is per-item and partial-failure-safe.
//
// These fail on pre-change code: media-delete.ts, gallery-aware findMediaUsage,
// and the deleteMedia opt-in did not exist.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import type { MediaStorage, StoredObject } from "@/lib/media/storage";
import { createMedia, getMediaById } from "@/lib/content/media";
import { createPost, getPostById } from "@/lib/content/posts";
import {
  findMediaUsage,
  listMediaWithUsage,
} from "@/lib/content/media-usage";
import {
  deleteMediaById,
  collectPostMediaIds,
  postMediaDeletionPreview,
  deletePostWithMedia,
  bulkDeleteMedia,
} from "@/lib/content/media-delete";

class MemoryStorage implements MediaStorage {
  readonly objects = new Map<string, { buffer: Buffer; contentType: string }>();
  readonly deleted: string[] = [];
  /** Keys whose delete() throws — to simulate a mid-cleanup store fault (F2). */
  readonly throwKeys = new Set<string>();
  async ensureBucket(): Promise<void> {}
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { buffer: body, contentType });
  }
  async get(key: string): Promise<StoredObject> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`no object: ${key}`);
    return {
      stream: Readable.from(o.buffer),
      contentType: o.contentType,
      size: o.buffer.length,
    };
  }
  async delete(key: string): Promise<void> {
    if (this.throwKeys.has(key)) throw new Error(`store fault: ${key}`);
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

let h: TestDb;
let db: Db;
let storage: MemoryStorage;
beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
  storage = new MemoryStorage();
});
afterEach(() => h.close());

let seq = 0;
/** Create a media row with a distinct pipeline-style key + one variant. */
async function media(alt = "") {
  seq += 1;
  const uuid = `${String(seq).padStart(8, "0")}-0000-0000-0000-000000000000`;
  return createMedia(db, {
    storageKey: `${uuid}/800.jpg`,
    alt,
    responsiveSizes: [
      { width: 400, height: 300, key: `${uuid}/400.jpg` },
      { width: 800, height: 600, key: `${uuid}/800.jpg` },
    ],
  });
}

// ── deleteMediaById: the gate + object cleanup ───────────────────────────────

test("deleteMediaById: an unused image is removed (row + every object variant)", async () => {
  const m = await media("lonely");
  const res = await deleteMediaById(db, storage, m.id);
  expect(res.status).toBe("deleted");
  expect(await getMediaById(db, m.id)).toBeNull();
  // Both the primary and the smaller variant object are deleted.
  expect(storage.deleted).toContain(m.storageKey);
  expect(storage.deleted.length).toBeGreaterThanOrEqual(2);
});

test("deleteMediaById: a cover-referenced image is BLOCKED without force", async () => {
  const m = await media("hero");
  await createPost(db, {
    title: "Has cover",
    slug: "has-cover",
    body: "no body image",
    coverImage: { src: `/media/${m.storageKey}`, alt: "hero" },
    type: "article",
    status: "published",
  });
  const res = await deleteMediaById(db, storage, m.id);
  expect(res.status).toBe("in_use");
  expect(res.usage?.length).toBe(1);
  expect(res.usage?.[0].field).toBe("cover");
  // Nothing removed.
  expect(await getMediaById(db, m.id)).not.toBeNull();
  expect(storage.deleted).toHaveLength(0);
});

test("deleteMediaById: force removes the image AND strips the dangling cover", async () => {
  const m = await media("hero");
  const post = await createPost(db, {
    title: "Has cover",
    slug: "has-cover-2",
    body: "plain",
    coverImage: { src: `/media/${m.storageKey}`, alt: "hero" },
    type: "article",
    status: "published",
  });
  const res = await deleteMediaById(db, storage, m.id, { force: true });
  expect(res.status).toBe("deleted");
  expect(await getMediaById(db, m.id)).toBeNull();
  // The cover reference is stripped so the public site never renders a 404 img.
  const updated = await getPostById(db, post.id);
  expect(updated?.coverImage).toBeNull();
});

// ── gallery membership counts as usage (the 047 gap this closes) ─────────────

test("findMediaUsage: a gallery-only image is reported IN USE (post_media join)", async () => {
  const m = await media("in a gallery");
  await createPost(db, {
    title: "Album",
    slug: "album",
    body: "",
    type: "photo-post",
    status: "published",
    isGallery: true,
    gallery: [{ mediaId: m.id, alt: "in a gallery" }],
  });
  const usage = await findMediaUsage(db, m.id);
  expect(usage.length).toBe(1);
  expect(usage[0].field).toBe("gallery");
  // …and therefore the delete gate blocks it without force.
  const res = await deleteMediaById(db, storage, m.id);
  expect(res.status).toBe("in_use");
});

// ── 056: delete a photo post, optionally its media, keeping shared photos ─────

async function galleryPost(slug: string, ids: string[], title = slug) {
  return createPost(db, {
    title,
    slug,
    body: "",
    type: "photo-post",
    status: "published",
    isGallery: true,
    gallery: ids.map((id) => ({ mediaId: id, alt: "described" })),
  });
}

test("deletePostWithMedia: deletes the post's unshared photos, KEEPS a shared one", async () => {
  const a = await media("a");
  const b = await media("b");
  const shared = await media("shared");
  const post = await galleryPost("trip", [a.id, b.id, shared.id]);
  // A second gallery also uses `shared`.
  const other = await galleryPost("other", [shared.id]);

  // Preview (before deletion) is honest about what stays.
  const preview = await postMediaDeletionPreview(db, post.id);
  expect(preview).toEqual({ total: 3, deletable: 2, shared: 1 });

  const res = await deletePostWithMedia(db, storage, post.id, {
    deleteMedia: true,
  });
  expect(res).toEqual({
    postDeleted: true,
    deletedMedia: 2,
    keptMedia: 1,
    failedMedia: 0,
  });

  // Post gone; unshared photos gone; shared photo kept and still in the other post.
  expect(await getPostById(db, post.id)).toBeNull();
  expect(await getMediaById(db, a.id)).toBeNull();
  expect(await getMediaById(db, b.id)).toBeNull();
  expect(await getMediaById(db, shared.id)).not.toBeNull();
  const otherAfter = await getPostById(db, other.id);
  expect(otherAfter?.gallery.map((g) => g.mediaId)).toEqual([shared.id]);
});

test("deletePostWithMedia: without the opt-in, the post is deleted but media kept", async () => {
  const a = await media("a");
  const post = await galleryPost("keep-media", [a.id]);
  const res = await deletePostWithMedia(db, storage, post.id, {
    deleteMedia: false,
  });
  expect(res.deletedMedia).toBe(0);
  expect(await getPostById(db, post.id)).toBeNull();
  expect(await getMediaById(db, a.id)).not.toBeNull();
});

test("collectPostMediaIds: resolves a Single photo post's cover media", async () => {
  const cover = await media("single cover");
  const post = await createPost(db, {
    title: "Single",
    slug: "single",
    body: "plain",
    type: "photo-post",
    status: "published",
    isGallery: false,
    coverImage: { src: `/media/${cover.storageKey}`, alt: "single cover" },
  });
  const ids = await collectPostMediaIds(db, (await getPostById(db, post.id))!);
  expect(ids).toContain(cover.id);
});

// ── 057: bulk delete — usage-aware + partial-failure-safe ────────────────────

test("bulkDeleteMedia: deletes free items, reports the in-use one (no force)", async () => {
  const free1 = await media("free1");
  const free2 = await media("free2");
  const used = await media("used");
  await createPost(db, {
    title: "Uses one",
    slug: "uses-one",
    body: `see ![x](/media/${used.storageKey})`,
    type: "article",
    status: "published",
  });

  const out = await bulkDeleteMedia(db, storage, [free1.id, free2.id, used.id]);
  expect(out.deleted).toBe(2);
  expect(out.inUse).toBe(1);
  const usedResult = out.results.find((r) => r.id === used.id);
  expect(usedResult?.status).toBe("in_use");
  expect(usedResult?.usage?.length).toBe(1);
  // The free items are gone; the in-use one is untouched.
  expect(await getMediaById(db, free1.id)).toBeNull();
  expect(await getMediaById(db, used.id)).not.toBeNull();
});

test("bulkDeleteMedia: force removes the in-use item too, stripping its reference", async () => {
  const used = await media("used");
  const post = await createPost(db, {
    title: "Uses one",
    slug: "uses-force",
    body: `see ![x](/media/${used.storageKey}) end`,
    type: "article",
    status: "published",
  });
  const out = await bulkDeleteMedia(db, storage, [used.id], { force: true });
  expect(out.deleted).toBe(1);
  expect(await getMediaById(db, used.id)).toBeNull();
  const updated = await getPostById(db, post.id);
  expect(updated?.body).not.toContain(used.storageKey);
});

test("bulkDeleteMedia: a missing id is reported, the rest still delete; dupes dedup", async () => {
  const m = await media("real");
  const out = await bulkDeleteMedia(db, storage, [
    m.id,
    m.id, // duplicate — must not double-process
    "00000000-0000-0000-0000-0000000000ff",
  ]);
  expect(out.results.length).toBe(2); // deduped to 2 distinct ids
  expect(out.deleted).toBe(1);
  const missing = out.results.find(
    (r) => r.id === "00000000-0000-0000-0000-0000000000ff",
  );
  expect(missing?.status).toBe("not_found");
});

// ── F1: the SSR/list count is gallery-aware (matches the API + delete gate) ───

test("listMediaWithUsage: a gallery-only photo reports usageCount ≥ 1 (not Unused)", async () => {
  const inGallery = await media("only in a gallery");
  const orphan = await media("truly unused");
  await galleryPost("album", [inGallery.id]);

  const list = await listMediaWithUsage(db);
  const galleryItem = list.find((i) => i.id === inGallery.id);
  const orphanItem = list.find((i) => i.id === orphan.id);
  // The gallery member is counted as used on the first-paint/API list — the F1
  // skew (findUsageInContent-only SSR count) would have shown 0 here.
  expect(galleryItem?.usageCount).toBeGreaterThanOrEqual(1);
  // A genuinely unused image still reads 0 — the merge didn't over-count.
  expect(orphanItem?.usageCount).toBe(0);
});

// ── F2: post-delete cleanup tolerates a per-item store fault ──────────────────

test("deletePostWithMedia: one photo's store fault does not abort the cleanup", async () => {
  const a = await media("a");
  const boom = await media("boom");
  const c = await media("c");
  const post = await galleryPost("trip", [a.id, boom.id, c.id]);
  // Make the middle photo's primary-object delete throw mid-loop.
  storage.throwKeys.add(boom.storageKey);

  // Must NOT throw even though one item faults after the post is already deleted.
  const res = await deletePostWithMedia(db, storage, post.id, {
    deleteMedia: true,
  });

  expect(res.postDeleted).toBe(true);
  expect(res.failedMedia).toBe(1);
  expect(res.deletedMedia).toBe(2); // the other two still deleted
  // The faulted media row is left intact (safe direction — no dangling ref);
  // the others are gone; the post is gone.
  expect(await getPostById(db, post.id)).toBeNull();
  expect(await getMediaById(db, a.id)).toBeNull();
  expect(await getMediaById(db, c.id)).toBeNull();
  expect(await getMediaById(db, boom.id)).not.toBeNull();
});
