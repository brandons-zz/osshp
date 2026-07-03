// Post store.
//
// Admin reads (getPostBySlug, listPosts) return posts of any status. The
// theme-materialization reads (getPublishedPostBySlug, listPublishedPosts)
// return ONLY status='published' rows — this is the published-only boundary
// the theme rendering contract requires (§3.3: draft and scheduled content
// never reach a theme).

import type { Db } from "@/lib/db/types";
import type { ImageRef, NewPost, Post, PostUpdate, Tag } from "./types";
import { ensureTag } from "./tags";
import { toIso, toIsoOrNull } from "./util";

interface PostRow {
  id: string;
  title: string;
  slug: string;
  body: string;
  excerpt: string;
  cover_image_src: string | null;
  cover_image_alt: string | null;
  type: Post["type"];
  panoramic: boolean;
  show_in_blog: boolean;
  featured: boolean;
  status: Post["status"];
  publish_date: unknown;
  created_at: unknown;
  updated_at: unknown;
  tags: Tag[];
}

// Selects all post columns plus an aggregated tag array, ordered by tag name.
// json_agg over the join avoids an N+1 per post; COALESCE handles no-tag posts.
const POST_SELECT = `
  SELECT p.id, p.title, p.slug, p.body, p.excerpt,
         p.cover_image_src, p.cover_image_alt, p.type, p.panoramic, p.show_in_blog, p.featured, p.status,
         p.publish_date, p.created_at, p.updated_at,
         COALESCE(
           (SELECT json_agg(
                     json_build_object('id', t.id, 'name', t.name, 'slug', t.slug)
                     ORDER BY t.name)
            FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = p.id),
           '[]'::json
         ) AS tags
  FROM posts p`;

function coverImage(row: PostRow): ImageRef | null {
  if (row.cover_image_src === null) return null;
  return { src: row.cover_image_src, alt: row.cover_image_alt ?? "" };
}

function mapPost(row: PostRow): Post {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    body: row.body,
    excerpt: row.excerpt,
    coverImage: coverImage(row),
    type: row.type,
    panoramic: row.panoramic ?? false,
    showInBlog: row.show_in_blog ?? false,
    featured: row.featured ?? false,
    status: row.status,
    publishDate: toIsoOrNull(row.publish_date),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    tags: row.tags ?? [],
  };
}

async function attachTags(
  db: Db,
  postId: string,
  tags: Array<{ name: string; slug: string }>,
): Promise<void> {
  await db.query(`DELETE FROM post_tags WHERE post_id = $1`, [postId]);
  for (const t of tags) {
    const tag = await ensureTag(db, t.name, t.slug);
    await db.query(
      `INSERT INTO post_tags (post_id, tag_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [postId, tag.id],
    );
  }
}

async function getPostByIdInternal(db: Db, id: string): Promise<Post | null> {
  const rows = await db.query<PostRow>(`${POST_SELECT} WHERE p.id = $1`, [id]);
  return rows[0] ? mapPost(rows[0]) : null;
}

export async function createPost(db: Db, input: NewPost): Promise<Post> {
  // created_at/updated_at: COALESCE to the DB's now() default when the caller
  // omits them (the normal authoring path); content import (issue 002) passes
  // the source's original timestamps to preserve them on a lossless round-trip.
  const rows = await db.query<{ id: string }>(
    `INSERT INTO posts
       (title, slug, body, excerpt, cover_image_src, cover_image_alt, type, panoramic, show_in_blog, featured, status, publish_date, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13, now()), COALESCE($14, now()))
     RETURNING id`,
    [
      input.title,
      input.slug,
      input.body,
      input.excerpt ?? "",
      input.coverImage?.src ?? null,
      input.coverImage?.alt ?? null,
      input.type ?? "article",
      input.panoramic ?? false,
      input.showInBlog ?? false,
      input.featured ?? false,
      input.status ?? "draft",
      input.publishDate ?? null,
      input.createdAt ?? null,
      input.updatedAt ?? null,
    ],
  );
  const id = rows[0].id;
  if (input.tags && input.tags.length > 0) {
    await attachTags(db, id, input.tags);
  }
  const post = await getPostByIdInternal(db, id);
  if (!post) throw new Error("createPost: row vanished after insert");
  return post;
}

export async function getPostById(db: Db, id: string): Promise<Post | null> {
  return getPostByIdInternal(db, id);
}

export async function getPostBySlug(
  db: Db,
  slug: string,
): Promise<Post | null> {
  const rows = await db.query<PostRow>(`${POST_SELECT} WHERE p.slug = $1`, [
    slug,
  ]);
  return rows[0] ? mapPost(rows[0]) : null;
}

/** Admin listing — all statuses. Optionally filter to a single status. */
export async function listPosts(
  db: Db,
  opts: { status?: Post["status"] } = {},
): Promise<Post[]> {
  const rows = opts.status
    ? await db.query<PostRow>(
        `${POST_SELECT} WHERE p.status = $1 ORDER BY p.created_at DESC`,
        [opts.status],
      )
    : await db.query<PostRow>(`${POST_SELECT} ORDER BY p.created_at DESC`);
  return rows.map(mapPost);
}

export async function updatePost(
  db: Db,
  id: string,
  patch: PostUpdate,
): Promise<Post | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (patch.title !== undefined) set("title", patch.title);
  if (patch.slug !== undefined) set("slug", patch.slug);
  if (patch.body !== undefined) set("body", patch.body);
  if (patch.excerpt !== undefined) set("excerpt", patch.excerpt);
  if (patch.coverImage !== undefined) {
    set("cover_image_src", patch.coverImage?.src ?? null);
    set("cover_image_alt", patch.coverImage?.alt ?? null);
  }
  if (patch.type !== undefined) set("type", patch.type);
  if (patch.panoramic !== undefined) set("panoramic", patch.panoramic);
  if (patch.showInBlog !== undefined) set("show_in_blog", patch.showInBlog);
  if (patch.featured !== undefined) set("featured", patch.featured);
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.publishDate !== undefined) set("publish_date", patch.publishDate);
  if (patch.createdAt !== undefined) set("created_at", patch.createdAt);
  // Import's "overwrite existing" mode (issue 002) passes an explicit
  // updatedAt to restore the source's original value; every other caller
  // omits it and gets the normal stamp-at-write-time auto-update below.
  if (patch.updatedAt !== undefined) set("updated_at", patch.updatedAt);

  if (sets.length > 0) {
    if (patch.updatedAt === undefined) sets.push(`updated_at = now()`);
    params.push(id);
    const result = await db.query<{ id: string }>(
      `UPDATE posts SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (result.length === 0) return null;
  } else {
    const exists = await db.query<{ id: string }>(
      `SELECT id FROM posts WHERE id = $1`,
      [id],
    );
    if (exists.length === 0) return null;
  }

  if (patch.tags !== undefined) {
    await attachTags(db, id, patch.tags);
  }
  return getPostByIdInternal(db, id);
}

export async function deletePost(db: Db, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `DELETE FROM posts WHERE id = $1 RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

// ── Published-only reads (theme materialization boundary, §3.3) ────────────
//
// "Visible" means: status='published' OR (status='scheduled' AND publish_date IS
// NOT NULL AND publish_date <= now()). Scheduled posts auto-reveal when their
// publish_date passes — no manual status flip required. Future-dated scheduled
// posts stay hidden until that moment.

const VISIBLE_FILTER =
  `(p.status = 'published' OR ` +
  `(p.status = 'scheduled' AND p.publish_date IS NOT NULL AND p.publish_date <= now()))`;

export async function getPublishedPostBySlug(
  db: Db,
  slug: string,
): Promise<Post | null> {
  const rows = await db.query<PostRow>(
    `${POST_SELECT} WHERE p.slug = $1 AND ${VISIBLE_FILTER}`,
    [slug],
  );
  return rows[0] ? mapPost(rows[0]) : null;
}

/** Published (or past-scheduled) posts, newest first — the source for
 *  post-list / home / tag / photo-list targets.
 *
 *  `type` narrows to one post type (e.g. 'photo-post' for the Photos grid);
 *  omitted = all types.
 *
 *  `blogStream: true` restricts to blog-listing scope: articles always included;
 *  photo-posts included ONLY if show_in_blog=true. Use for /blog listing,
 *  home feed, and RSS — not for the photos grid or tag pages. */
export async function listPublishedPosts(
  db: Db,
  opts: { tagSlug?: string; type?: Post["type"]; blogStream?: boolean } = {},
): Promise<Post[]> {
  const params: unknown[] = [];
  const clauses: string[] = [VISIBLE_FILTER];
  if (opts.type) {
    params.push(opts.type);
    clauses.push(`p.type = $${params.length}`);
  }
  if (opts.blogStream) {
    // Articles always appear in the blog stream; photo-posts only if opted in.
    clauses.push(
      `(p.type = 'article' OR (p.type = 'photo-post' AND p.show_in_blog = true))`,
    );
  }
  if (opts.tagSlug) {
    params.push(opts.tagSlug);
    clauses.push(
      `EXISTS (
         SELECT 1 FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.post_id = p.id AND t.slug = $${params.length}
       )`,
    );
  }
  const rows = await db.query<PostRow>(
    `${POST_SELECT} WHERE ${clauses.join(" AND ")}
     ORDER BY p.publish_date DESC NULLS LAST`,
    params,
  );
  return rows.map(mapPost);
}

/**
 * Published (or past-scheduled) posts flagged `featured`, of ANY type, newest
 * first — the source for the home "§ 00 · Selected" showcase (issue 012). Unlike
 * the blog stream, this ignores type: a featured photo-post appears in the
 * showcase even when it is not opted into the /blog listing (linking to its
 * /photos/<slug> home). Newest-first ordering lets the caller take a stable
 * "newest N" slice or a random rotation from a fully-ordered set.
 */
export async function listPublishedFeatured(db: Db): Promise<Post[]> {
  const rows = await db.query<PostRow>(
    `${POST_SELECT} WHERE ${VISIBLE_FILTER} AND p.featured = true
     ORDER BY p.publish_date DESC NULLS LAST`,
  );
  return rows.map(mapPost);
}
