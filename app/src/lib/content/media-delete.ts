// Usage-aware media deletion — the one place the delete gate + object cleanup +
// content-reference stripping live, reused by every delete surface:
//   - single delete (DELETE /api/admin/media/[id])            — issue 037 §2.4
//   - bulk delete   (POST  /api/admin/media/bulk-delete)      — issue 057
//   - photo-post delete with media cleanup (DELETE …/photos/posts/[id]?deleteMedia=1)
//                                                              — issue 056
//
// The gate is honest: a media referenced by any post/page (cover, body, OR a
// gallery membership — issue 047) is NOT removed unless the caller passes force,
// and force first strips the now-dangling content references so the public site
// never renders a 404 <img>. Gallery membership rows are cleaned by the
// post_media ON DELETE CASCADE when the media row is dropped (migration 0009), so
// only cover/body TEXT needs explicit stripping.
//
// Storage is injected (the MediaStorage seam) so this whole module is unit
// -testable against PGlite + an in-memory store, with no live object storage.

import type { Db } from "@/lib/db/types";
import type { MediaStorage } from "@/lib/media/storage";
import type { Post } from "./types";
import { getMediaById, getMediaByKey, deleteMedia } from "./media";
import { getPostById, deletePost } from "./posts";
import {
  findMediaUsage,
  mediaReferenceUrls,
  stripMediaReferences,
  type MediaUsageRef,
} from "./media-usage";

/** Outcome of attempting to delete a single media item. */
export interface MediaDeleteResult {
  id: string;
  /**
   *  - "deleted"   — objects + row removed (and, on force, references stripped).
   *  - "in_use"    — referenced and force not set; nothing changed. `usage` lists refs.
   *  - "not_found" — no such media id; nothing changed.
   *  - "error"     — an unexpected failure; nothing durable assumed. `error` set.
   */
  status: "deleted" | "in_use" | "not_found" | "error";
  usage?: MediaUsageRef[];
  error?: string;
}

/**
 * Delete one media item, usage-aware. When it is referenced and `force` is not
 * set, returns "in_use" with the reference list and touches nothing. With
 * `force` (or when unused), strips any cover/body references first, then removes
 * every stored object (primary + responsive variants; delete() is idempotent)
 * and finally the row. post_media gallery rows are cleaned by the FK cascade.
 */
export async function deleteMediaById(
  db: Db,
  storage: MediaStorage,
  id: string,
  opts: { force?: boolean } = {},
): Promise<MediaDeleteResult> {
  const media = await getMediaById(db, id);
  if (!media) return { id, status: "not_found" };

  const usage = await findMediaUsage(db, id);
  if (usage.length > 0 && !opts.force) {
    return { id, status: "in_use", usage };
  }

  const urls = mediaReferenceUrls(media);
  if (usage.length > 0) {
    // Force path: clear covers / remove body image nodes so no dangling ref
    // survives. Gallery membership needs no text edit — the CASCADE drops it.
    await stripMediaReferences(db, urls);
  }

  const keys = new Set<string>([
    media.storageKey,
    ...media.responsiveSizes.map((s) => s.key),
  ]);
  for (const key of keys) {
    await storage.delete(key);
  }
  await deleteMedia(db, id);
  return { id, status: "deleted", usage };
}

/** Public /media/<key> URL → its storage key, or null when it is not a /media URL. */
function srcToKey(src: string): string | null {
  const prefix = "/media/";
  return src.startsWith(prefix) ? src.slice(prefix.length) : null;
}

/**
 * The media a photo post "owns": its gallery members plus, for a Single photo
 * post, the media behind its cover URL (best-effort — an unresolvable/imported
 * cover is simply not offered for deletion rather than risking the wrong id).
 * De-duplicated. This is the candidate set the post-delete cleanup considers;
 * whether each is actually removed is decided by the usage gate (shared media is
 * kept).
 */
export async function collectPostMediaIds(
  db: Db,
  post: Post,
): Promise<string[]> {
  const ids = new Set<string>();
  for (const g of post.gallery) ids.add(g.mediaId);
  if (post.isGallery && post.coverMediaId) ids.add(post.coverMediaId);
  if (!post.isGallery && post.coverImage?.src) {
    const key = srcToKey(post.coverImage.src);
    const media = key ? await getMediaByKey(db, key) : null;
    if (media) ids.add(media.id);
  }
  return Array.from(ids);
}

/** A photo post's media-cleanup preview: how many of its photos would be deleted
 *  vs kept (kept = shared with another post/page) if the post were deleted. */
export interface PostMediaDeletionPreview {
  /** Photos this post owns (gallery members + resolved single cover). */
  total: number;
  /** Owned photos referenced ONLY by this post → safe to delete with the post. */
  deletable: number;
  /** Owned photos also used elsewhere → kept when the post is deleted. */
  shared: number;
}

/**
 * Compute the media-cleanup preview WITHOUT mutating anything (the post still
 * exists). A photo is "deletable" iff this post is its only referencer; a photo
 * also referenced by another post (cover, body, or another gallery) or a page is
 * "shared" and would be kept. Powers the honest "Also delete the N photos?" copy.
 */
export async function postMediaDeletionPreview(
  db: Db,
  postId: string,
): Promise<PostMediaDeletionPreview> {
  const post = await getPostById(db, postId);
  if (!post) return { total: 0, deletable: 0, shared: 0 };
  const ownedIds = await collectPostMediaIds(db, post);
  let deletable = 0;
  let shared = 0;
  for (const id of ownedIds) {
    const usage = await findMediaUsage(db, id); // includes this post
    const elsewhere = usage.some((u) => u.id !== postId);
    if (elsewhere) shared += 1;
    else deletable += 1;
  }
  return { total: ownedIds.length, deletable, shared };
}

/** Outcome of deleting a photo post together with its owned media. */
export interface DeletePostWithMediaResult {
  postDeleted: boolean;
  /** Owned photos removed (were referenced only by this post). */
  deletedMedia: number;
  /** Owned photos kept because they are still used elsewhere. */
  keptMedia: number;
  /**
   * Owned photos whose cleanup failed (store/DB fault). The post is already gone
   * and the media row is left intact — safe direction, no dangling reference; the
   * operator can retry from the media library. Zero on the happy path.
   */
  failedMedia: number;
}

/**
 * Delete a photo post AND, when `deleteMedia` is set, its now-unreferenced media
 * (issue 056). The post is deleted FIRST — that drops its post_media rows and
 * clears its cover pointer — so the subsequent per-photo usage gate naturally
 * sees only OTHER references. A photo still referenced by another post/page is
 * kept (never silently orphaned); an unshared photo is removed. With
 * `deleteMedia` false this is exactly today's behavior (post only).
 */
export async function deletePostWithMedia(
  db: Db,
  storage: MediaStorage,
  postId: string,
  opts: { deleteMedia: boolean },
): Promise<DeletePostWithMediaResult> {
  const post = await getPostById(db, postId);
  if (!post)
    return {
      postDeleted: false,
      deletedMedia: 0,
      keptMedia: 0,
      failedMedia: 0,
    };

  // Capture the candidate media BEFORE the post (and its post_media rows) go away.
  const ownedIds = opts.deleteMedia ? await collectPostMediaIds(db, post) : [];

  await deletePost(db, postId);

  let deletedMedia = 0;
  let keptMedia = 0;
  let failedMedia = 0;
  for (const id of ownedIds) {
    // Per-item tolerance (like bulkDeleteMedia): the post is ALREADY deleted, so
    // a storage/DB failure on one photo must not abort the loop and 500 the whole
    // op — that would strand the remaining candidates and make a retry 404 on the
    // gone post. Failure direction is safe (the media row stays, nothing dangles);
    // we count it and continue.
    try {
      // force:false → the gate re-checks usage now that the post is gone; a photo
      // shared with another post comes back "in_use" and is left intact.
      const res = await deleteMediaById(db, storage, id, { force: false });
      if (res.status === "deleted") deletedMedia += 1;
      else if (res.status === "in_use") keptMedia += 1;
      else if (res.status === "error") failedMedia += 1;
      // "not_found" (already gone) → neither; nothing to report.
    } catch {
      // deleteMediaById is not expected to throw, but a store/DB fault here must
      // not take down the whole cleanup — record and move on.
      failedMedia += 1;
    }
  }
  return { postDeleted: true, deletedMedia, keptMedia, failedMedia };
}

/** Per-item result within a bulk delete. Mirrors MediaDeleteResult. */
export type BulkMediaDeleteItem = MediaDeleteResult;

export interface BulkMediaDeleteResult {
  results: BulkMediaDeleteItem[];
  deleted: number;
  /** Items blocked because they are in use and force was not set. */
  inUse: number;
}

/**
 * Delete a set of media, usage-aware and robust to partial failure (issue 057).
 * Each item is deleted independently: one item throwing or being blocked does
 * NOT corrupt or abort the rest — every id gets a per-item result. When `force`
 * is not set, in-use items come back "in_use" (with their references) so the
 * client can list them and re-issue with force; deletable items are removed in
 * the same pass.
 */
export async function bulkDeleteMedia(
  db: Db,
  storage: MediaStorage,
  ids: readonly string[],
  opts: { force?: boolean } = {},
): Promise<BulkMediaDeleteResult> {
  const results: BulkMediaDeleteItem[] = [];
  // De-dup while preserving order — a repeated id must not be deleted twice.
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      results.push(await deleteMediaById(db, storage, id, opts));
    } catch (e) {
      results.push({
        id,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return {
    results,
    deleted: results.filter((r) => r.status === "deleted").length,
    inUse: results.filter((r) => r.status === "in_use").length,
  };
}
