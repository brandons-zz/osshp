// On-demand media usage scan (issue 037 §5; key-shape fix issue 039).
//
// Content links media by URL STRING, not a foreign key: a post's
// `cover_image_src` and any post/page `body` may embed `/media/<key>`. The only
// ground truth for "is this image used?" is the content itself — so usage is
// computed by scanning content on demand, with no denormalized references table
// to drift (design §5: correct-by-construction, zero migration, cheap at
// single-site scale).
//
// MATCH ON THE MEDIA'S EXACT REFERENCE URLS — never a "first path segment"
// prefix (issue 039). `media.id` is a DB gen_random_uuid() distinct from the
// object-store key, and keys come in several shapes:
//   - pipeline uploads: `<uuid>/1600.jpg` (+ `<uuid>/400.jpg`, `<uuid>/800.jpg`
//     variant siblings) — all reference URLs are `/media/<uuid>/<w>.<ext>`.
//   - imported media: `migrated/<file>` or `migrated-wp/<file>` — MANY items
//     share the `migrated` first segment, so a first-segment prefix would
//     CONFLATE every imported image into one anchor (inflated counts, over-blocked
//     deletes). A flat key `foo.png` would yield a bogus `/media/foo.png/`
//     (trailing slash) that never matches the real ref → usage 0 → an unsafe
//     force-delete gate.
// The reference-URL set of a media record is therefore its primary URL plus one
// URL per responsive-variant key: `/media/<storageKey>` and `/media/<key>` for
// each responsive size. A content item uses the media iff a cover equals, or a
// body contains, ANY of those exact URLs. This is exact per key shape.
//
// One helper set serves four consumers: the library list counts (§1.1), the
// where-used panel + delete gate (§1.2/§1.4), the replace reference-rewrite
// (§1.5/§7), and the force-delete reference cleanup (§2.4). The pure
// `findUsageInContent` is unit-testable without a DB.

import type { Db } from "@/lib/db/types";
import { getMediaById, listMedia } from "./media";
import { toMediaListItem, type MediaListItem } from "./media-view";

/** The minimal media shape the scan needs: its keys → its reference URLs. */
export interface MediaKeys {
  storageKey: string;
  responsiveSizes: Array<{ key: string }>;
}

/** A single content item that references a media upload. */
export interface MediaUsageRef {
  type: "post" | "page";
  id: string;
  title: string;
  slug: string;
  /**
   * Where the reference was found. A post can reference an image three ways:
   *   - "cover"   — the post's cover_image_src.
   *   - "body"    — an inline Markdown image in a post/page body.
   *   - "gallery" — a post_media membership row (issue 047 galleries). This is a
   *     JOIN row, NOT embedded text, so the pure cover/body scan cannot see it —
   *     it is merged in by the DB-level scans below. Without this a gallery-only
   *     image reads as "Unused" and would force-delete silently, breaking the
   *     gallery it belongs to (issues 056/057: never silently orphan / keep
   *     media shared with another post).
   * When one post references an image several ways, a single row is kept,
   * preferring cover → gallery → body.
   */
  field: "cover" | "body" | "gallery";
  /** Admin edit URL for the referencing content. */
  adminHref: string;
}

interface ScanPost {
  id: string;
  type: string;
  title: string;
  slug: string;
  cover_image_src: string | null;
  body: string;
}
interface ScanPage {
  id: string;
  title: string;
  slug: string;
  body: string;
}

/** A one-shot snapshot of all content, scanned in memory for every media id. */
export interface ScanContent {
  posts: ScanPost[];
  pages: ScanPage[];
}

/**
 * The EXACT public reference URLs of a media record: its primary URL plus one
 * per responsive-variant key, de-duplicated. This is the anchor set the scan,
 * the delete gate, the replace rewrite, and the force-delete cleanup all use —
 * no prefix guessing (issue 039).
 */
export function mediaReferenceUrls(media: MediaKeys): string[] {
  const keys = [media.storageKey, ...media.responsiveSizes.map((s) => s.key)];
  const urls = keys.filter(Boolean).map((k) => `/media/${k}`);
  return Array.from(new Set(urls));
}

function postAdminHref(post: ScanPost): string {
  return post.type === "photo-post"
    ? `/admin/photos/${post.id}/edit`
    : `/admin/blog/${post.id}/edit`;
}

/**
 * Pure scan: which content items reference any of `urls` (a media's exact
 * reference URLs — see mediaReferenceUrls). One row per content item — a post
 * that uses the image in both cover and body yields a single row flagged "cover"
 * (the count is items, not occurrences). No DB.
 */
export function findUsageInContent(
  content: ScanContent,
  urls: string[],
): MediaUsageRef[] {
  const refs: MediaUsageRef[] = [];
  if (urls.length === 0) return refs;

  const inCover = (cover: string | null) => cover !== null && urls.includes(cover);
  const inBody = (body: string) => urls.some((u) => body.includes(u));

  for (const post of content.posts) {
    const cover = inCover(post.cover_image_src);
    const body = inBody(post.body);
    if (cover || body) {
      refs.push({
        type: "post",
        id: post.id,
        title: post.title,
        slug: post.slug,
        field: cover ? "cover" : "body",
        adminHref: postAdminHref(post),
      });
    }
  }
  for (const page of content.pages) {
    if (inBody(page.body)) {
      refs.push({
        type: "page",
        id: page.id,
        title: page.title,
        slug: page.slug,
        field: "body",
        adminHref: `/admin/pages/${page.id}/edit`,
      });
    }
  }
  return refs;
}

/** Merge usage rows from several scans into one row per content item. A post
 *  found in both cover/body text AND a gallery membership collapses to a single
 *  row (the count is items, not occurrences); field precedence cover > gallery >
 *  body so the most specific relationship wins. */
export function mergeUsageRefs(...groups: MediaUsageRef[][]): MediaUsageRef[] {
  const rank: Record<MediaUsageRef["field"], number> = {
    cover: 0,
    gallery: 1,
    body: 2,
  };
  const byItem = new Map<string, MediaUsageRef>();
  for (const group of groups) {
    for (const ref of group) {
      const k = `${ref.type}:${ref.id}`;
      const existing = byItem.get(k);
      if (!existing || rank[ref.field] < rank[existing.field]) {
        byItem.set(k, ref);
      }
    }
  }
  return Array.from(byItem.values());
}

interface GalleryUsageRow {
  media_id: string;
  post_id: string;
  title: string;
  slug: string;
}

/**
 * Gallery (post_media) references, keyed by media id → usage rows. Gallery
 * membership is a JOIN row, not embedded text, so it is invisible to the
 * cover/body content scan (findUsageInContent) — this DB scan supplies it so the
 * library counts, the delete gate, and the post-delete cleanup all treat a
 * gallery photo as genuinely in use (issues 056/057). Pass `mediaIds` to scope
 * the scan to a set; omit to load every gallery reference (library list).
 */
export async function loadGalleryUsage(
  db: Db,
  mediaIds?: readonly string[],
): Promise<Map<string, MediaUsageRef[]>> {
  const map = new Map<string, MediaUsageRef[]>();
  if (mediaIds && mediaIds.length === 0) return map;
  const rows = mediaIds
    ? await db.query<GalleryUsageRow>(
        `SELECT pm.media_id, p.id AS post_id, p.title, p.slug
           FROM post_media pm JOIN posts p ON p.id = pm.post_id
          WHERE pm.media_id = ANY($1)`,
        [mediaIds as string[]],
      )
    : await db.query<GalleryUsageRow>(
        `SELECT pm.media_id, p.id AS post_id, p.title, p.slug
           FROM post_media pm JOIN posts p ON p.id = pm.post_id`,
      );
  for (const r of rows) {
    const ref: MediaUsageRef = {
      type: "post",
      id: r.post_id,
      title: r.title,
      slug: r.slug,
      field: "gallery",
      // A gallery member is always a photo post; its editor is the photos route.
      adminHref: `/admin/photos/${r.post_id}/edit`,
    };
    const list = map.get(r.media_id);
    if (list) list.push(ref);
    else map.set(r.media_id, [ref]);
  }
  return map;
}

/** Load every post + page once (id/title/slug/body + post cover) for scanning. */
export async function loadScanContent(db: Db): Promise<ScanContent> {
  const posts = await db.query<ScanPost>(
    `SELECT id, type, title, slug, cover_image_src, body FROM posts`,
  );
  const pages = await db.query<ScanPage>(
    `SELECT id, title, slug, body FROM pages`,
  );
  return { posts, pages };
}

/**
 * Usage for a single media id. Resolves the record's reference URLs (exact per
 * key shape — issue 039), loads all content once, and scans. Returns [] if the
 * media id does not exist.
 */
export async function findMediaUsage(
  db: Db,
  mediaId: string,
): Promise<MediaUsageRef[]> {
  const media = await getMediaById(db, mediaId);
  if (!media) return [];
  const [content, galleryMap] = await Promise.all([
    loadScanContent(db),
    loadGalleryUsage(db, [mediaId]),
  ]);
  const contentRefs = findUsageInContent(content, mediaReferenceUrls(media));
  const galleryRefs = galleryMap.get(mediaId) ?? [];
  // Merge so a gallery member counts as in use, deduped per content item.
  return mergeUsageRefs(contentRefs, galleryRefs);
}

/**
 * The media library list DTO with correct usage counts (issues 037/039/056/057).
 * Loads media, all content, and all gallery membership once, then computes each
 * item's usage count as the DISTINCT content items referencing it via cover,
 * body, OR gallery membership. The single source of truth for the count shown by
 * BOTH the GET /api/admin/media response and the SSR /admin/media first paint —
 * so a gallery-only photo can never read "Unused" on one path and "Used" on the
 * other (the F1 skew this closes).
 */
export async function listMediaWithUsage(db: Db): Promise<MediaListItem[]> {
  const [media, content, galleryMap] = await Promise.all([
    listMedia(db),
    loadScanContent(db),
    loadGalleryUsage(db),
  ]);
  return media.map((m) => {
    // Match on the media's EXACT reference URLs, not a key prefix (issue 039).
    const contentRefs = findUsageInContent(content, mediaReferenceUrls(m));
    const galleryRefs = galleryMap.get(m.id) ?? [];
    const count = mergeUsageRefs(contentRefs, galleryRefs).length;
    return toMediaListItem(m, count);
  });
}

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove every Markdown image node `![alt](url)` referencing any of `urls`. */
function stripImageMarkdown(body: string, urls: string[]): string {
  let out = body;
  for (const url of urls) {
    const re = new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(url)}\\)`, "g");
    out = out.replace(re, "");
  }
  return out;
}

/**
 * Reference-rewrite for the replace flow (issue 037 §7). Rewrites every
 * occurrence of any URL in `oldUrls` to `newUrl` across post covers, post
 * bodies, and page bodies so a replaced image stays valid everywhere it is used
 * — regardless of which variant a body embedded. Skips URLs equal to `newUrl`.
 * Returns the number of row-updates applied.
 */
export async function rewriteMediaReferences(
  db: Db,
  oldUrls: string[],
  newUrl: string,
): Promise<number> {
  let changed = 0;
  for (const oldUrl of oldUrls) {
    if (oldUrl === newUrl) continue;
    const like = `%${oldUrl}%`;
    const coverRows = await db.query<{ id: string }>(
      `UPDATE posts SET cover_image_src = replace(cover_image_src, $1, $2)
       WHERE cover_image_src LIKE $3 RETURNING id`,
      [oldUrl, newUrl, like],
    );
    const postBodyRows = await db.query<{ id: string }>(
      `UPDATE posts SET body = replace(body, $1, $2)
       WHERE body LIKE $3 RETURNING id`,
      [oldUrl, newUrl, like],
    );
    const pageBodyRows = await db.query<{ id: string }>(
      `UPDATE pages SET body = replace(body, $1, $2)
       WHERE body LIKE $3 RETURNING id`,
      [oldUrl, newUrl, like],
    );
    changed += coverRows.length + postBodyRows.length + pageBodyRows.length;
  }
  return changed;
}

/**
 * Force-delete reference cleanup (issue 037 §2.4 / QA finding 1). When a
 * still-referenced media is force-deleted, its content references MUST be removed
 * so the public site never renders a 404 `<img>`. For each referencing item:
 *   - a cover pointing at any of `urls` is cleared (src + alt → NULL);
 *   - Markdown image nodes `![alt](url)` for any of `urls` are removed from the
 *     body.
 * Returns the number of content items changed. Runs a single content scan and
 * only writes rows that actually change.
 */
export async function stripMediaReferences(
  db: Db,
  urls: string[],
): Promise<number> {
  if (urls.length === 0) return 0;
  const content = await loadScanContent(db);
  let changed = 0;

  for (const post of content.posts) {
    const coverHit =
      post.cover_image_src !== null && urls.includes(post.cover_image_src);
    const newBody = stripImageMarkdown(post.body, urls);
    const bodyHit = newBody !== post.body;
    if (!coverHit && !bodyHit) continue;
    if (coverHit && bodyHit) {
      await db.query(
        `UPDATE posts SET cover_image_src = NULL, cover_image_alt = NULL, body = $2 WHERE id = $1`,
        [post.id, newBody],
      );
    } else if (coverHit) {
      await db.query(
        `UPDATE posts SET cover_image_src = NULL, cover_image_alt = NULL WHERE id = $1`,
        [post.id],
      );
    } else {
      await db.query(`UPDATE posts SET body = $2 WHERE id = $1`, [
        post.id,
        newBody,
      ]);
    }
    changed += 1;
  }

  for (const page of content.pages) {
    const newBody = stripImageMarkdown(page.body, urls);
    if (newBody === page.body) continue;
    await db.query(`UPDATE pages SET body = $2 WHERE id = $1`, [
      page.id,
      newBody,
    ]);
    changed += 1;
  }

  return changed;
}
