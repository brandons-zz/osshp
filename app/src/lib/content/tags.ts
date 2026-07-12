// Tag store.
//
// Admin tag management (rename/merge/delete) lives here alongside the
// existing get-or-create/list reads. The `post_tags` join has
// `ON DELETE CASCADE` on `tag_id` (migration 0001), so any function that
// removes a `tags` row (delete, and merge's absorb-then-drop step) never
// needs to touch `post_tags` directly for the removed side — the FK does it,
// atomically, with no window where a post_tags row can outlive its tag.

import type { Db } from "@/lib/db/types";
import type { Tag } from "./types";
import { VISIBLE_FILTER } from "./posts";
import { slugify } from "@/lib/slug";

interface TagRow {
  id: string;
  name: string;
  slug: string;
}

interface TagCountRow extends TagRow {
  count: number;
}

function mapTag(row: TagRow): Tag {
  return { id: row.id, name: row.name, slug: row.slug };
}

export const TAG_NAME_MAX_LENGTH = 60;

/** Validate a tag name (rename or create-via-editor). Returns an error
 *  message, or null when valid. Mirrors validateTitleSlugLength's shape
 *  (content/limits.ts) for consistency across admin surfaces. */
export function validateTagName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "tag name is required";
  if (trimmed.length > TAG_NAME_MAX_LENGTH) {
    return `tag name must be ${TAG_NAME_MAX_LENGTH} characters or fewer`;
  }
  if (slugify(trimmed).length === 0) {
    return "tag name must contain at least one letter or number";
  }
  return null;
}

/** Get-or-create a tag by slug. If the slug exists, its name is refreshed. */
export async function ensureTag(
  db: Db,
  name: string,
  slug: string,
): Promise<Tag> {
  const rows = await db.query<TagRow>(
    `INSERT INTO tags (name, slug) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, slug`,
    [name, slug],
  );
  return mapTag(rows[0]);
}

export async function getTagBySlug(
  db: Db,
  slug: string,
): Promise<Tag | null> {
  const rows = await db.query<TagRow>(
    `SELECT id, name, slug FROM tags WHERE slug = $1`,
    [slug],
  );
  return rows[0] ? mapTag(rows[0]) : null;
}

export async function listTags(db: Db): Promise<Tag[]> {
  const rows = await db.query<TagRow>(
    `SELECT id, name, slug FROM tags ORDER BY name`,
  );
  return rows.map(mapTag);
}

// ── Published-only reads (theme materialization boundary, §3.3) ────────────

/**
 * Tags with at least one VISIBLE post, plus that post count — the source for
 * the /tags index (issue 061). Uses the same VISIBLE_FILTER as
 * listPublishedPosts (published, or scheduled whose publish_date has passed)
 * so a tag's listed count always matches what /tags/<slug> actually shows; a
 * tag with zero visible posts is dropped by the INNER JOIN rather than shown
 * with a count of 0. Ordered by name for a stable, predictable index (matches
 * listPublishedPages' "ORDER BY title").
 */
export async function listPublishedTagCounts(
  db: Db,
): Promise<Array<{ tag: Tag; count: number }>> {
  const rows = await db.query<TagCountRow>(
    `SELECT t.id, t.name, t.slug, COUNT(*)::int AS count
     FROM tags t
     JOIN post_tags pt ON pt.tag_id = t.id
     JOIN posts p ON p.id = pt.post_id
     WHERE ${VISIBLE_FILTER}
     GROUP BY t.id, t.name, t.slug
     ORDER BY t.name`,
  );
  return rows.map((row) => ({ tag: mapTag(row), count: row.count }));
}

// ── Admin management (tag-management feature) ──────────────────────────────

export async function getTagById(db: Db, id: string): Promise<Tag | null> {
  const rows = await db.query<TagRow>(
    `SELECT id, name, slug FROM tags WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapTag(rows[0]) : null;
}

/** Normalize a tag name to its separator-and-case-insensitive comparison key:
 *  lowercase, all non-alphanumerics stripped. `self-hosting`, `Self Hosting`,
 *  and `selfhosting` all reduce to `selfhosting`. This is the whole point of
 *  the typeahead — the operator meant to reuse the existing tag, and a plain
 *  substring match misses it when their spelling differs only by a hyphen or
 *  space. Kept in sync with the SQL expression in searchTags below. */
export function normalizeTagKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Typeahead search for the editor's tag combobox. Matches on EITHER:
 *   - a case-insensitive substring of the raw name (the ordinary "starts
 *     typing the word" case), or
 *   - a substring of the NORMALIZED name (hyphens/spaces/case removed on both
 *     sides) — so `selfhosting` surfaces the existing `self-hosting` tag and
 *     vice versa, which is the near-duplicate-prevention the feature exists
 *     for. This is punctuation/spacing/case normalization only, NOT fuzzy
 *     matching — a genuinely different word still finds nothing (and the
 *     combobox then offers "Create tag").
 *  `%`/`_`/`\` in the raw-substring pattern are escaped so a typed literal
 *  never behaves as a LIKE wildcard; the normalized key contains only
 *  a-z0-9 by construction, so it needs no escaping. Ordered by name, capped. */
export async function searchTags(
  db: Db,
  query: string,
  limit = 8,
): Promise<Tag[]> {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  const normalized = normalizeTagKey(query);
  const rows = await db.query<TagRow>(
    `SELECT id, name, slug FROM tags
      WHERE name ILIKE $1 ESCAPE '\\'
         OR ($2 <> '' AND regexp_replace(lower(name), '[^a-z0-9]', '', 'g') LIKE $3)
      ORDER BY name LIMIT $4`,
    [`%${escaped}%`, normalized, `%${normalized}%`, limit],
  );
  return rows.map(mapTag);
}

/** Every tag with its total post count across ALL statuses (draft, scheduled,
 *  published) — the /admin/tags list. Unlike listPublishedTagCounts, a tag
 *  with zero posts is still shown (LEFT JOIN), since a newly created or
 *  just-emptied tag is exactly what an operator managing tags needs to see
 *  in order to clean it up. */
export async function listTagsWithCounts(
  db: Db,
): Promise<Array<{ tag: Tag; count: number }>> {
  const rows = await db.query<TagCountRow>(
    `SELECT t.id, t.name, t.slug, COUNT(pt.post_id)::int AS count
     FROM tags t
     LEFT JOIN post_tags pt ON pt.tag_id = t.id
     GROUP BY t.id, t.name, t.slug
     ORDER BY t.name`,
  );
  return rows.map((row) => ({ tag: mapTag(row), count: row.count }));
}

async function countTagPosts(db: Db, tagId: string): Promise<number> {
  const rows = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM post_tags WHERE tag_id = $1`,
    [tagId],
  );
  return rows[0]?.count ?? 0;
}

export type RenameTagResult =
  | { ok: true; tag: Tag }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "collision"; existing: Tag };

/**
 * Rename a tag (fixes a misspelling, rebrands a term) — reflected across
 * every post that carries it because the name/slug live on the ONE `tags`
 * row every `post_tags` entry points at; no per-post rewrite is needed.
 *
 * If the new name's slug collides with a DIFFERENT existing tag, the rename
 * is refused (not silently merged) — merging two tags is a bigger, more
 * destructive operation (it deletes a whole tag row) than a rename, so it
 * requires the operator to explicitly choose Merge with both tags visible,
 * rather than falling out of a same-looking rename by surprise.
 */
export async function renameTag(
  db: Db,
  id: string,
  newName: string,
): Promise<RenameTagResult> {
  const existing = await getTagById(db, id);
  if (!existing) return { ok: false, reason: "not-found" };

  const trimmedName = newName.trim();
  const newSlug = slugify(trimmedName);

  const collisionRows = await db.query<TagRow>(
    `SELECT id, name, slug FROM tags WHERE slug = $1 AND id != $2`,
    [newSlug, id],
  );
  if (collisionRows[0]) {
    return { ok: false, reason: "collision", existing: mapTag(collisionRows[0]) };
  }

  const rows = await db.query<TagRow>(
    `UPDATE tags SET name = $1, slug = $2 WHERE id = $3
     RETURNING id, name, slug`,
    [trimmedName, newSlug, id],
  );
  return { ok: true, tag: mapTag(rows[0]!) };
}

export type MergeTagsResult =
  | { ok: true; affectedPosts: number }
  | { ok: false; reason: "same-tag" }
  | { ok: false; reason: "not-found" };

/**
 * Merge `sourceId` into `targetId`: every post carrying the source tag ends
 * up tagged with the target (no duplicate post_tags rows — the composite PK
 * plus ON CONFLICT DO NOTHING guarantees that), and the source tag is
 * removed. Runs in a transaction (falls back to sequential on a minimal Db
 * seam without one) so a mid-merge failure never leaves posts double-tagged
 * or the source half-deleted.
 */
export async function mergeTags(
  db: Db,
  sourceId: string,
  targetId: string,
): Promise<MergeTagsResult> {
  if (sourceId === targetId) return { ok: false, reason: "same-tag" };
  const [source, target] = await Promise.all([
    getTagById(db, sourceId),
    getTagById(db, targetId),
  ]);
  if (!source || !target) return { ok: false, reason: "not-found" };

  const affectedPosts = await countTagPosts(db, sourceId);

  const run = async (tx: Db): Promise<void> => {
    await tx.query(
      `INSERT INTO post_tags (post_id, tag_id)
       SELECT post_id, $2 FROM post_tags WHERE tag_id = $1
       ON CONFLICT (post_id, tag_id) DO NOTHING`,
      [sourceId, targetId],
    );
    // Removing the source tag cascades to delete its (now-redundant)
    // post_tags rows — see the file-header note.
    await tx.query(`DELETE FROM tags WHERE id = $1`, [sourceId]);
  };
  if (db.transaction) {
    await db.transaction(run);
  } else {
    await run(db);
  }
  return { ok: true, affectedPosts };
}

/** Delete a tag: removed from every post (post_tags cascades) and from the
 *  list; the posts themselves are untouched. Returns how many posts were
 *  affected (for a confirm-dialog message), or null if the tag didn't exist. */
export async function deleteTag(
  db: Db,
  id: string,
): Promise<{ affectedPosts: number } | null> {
  const existing = await getTagById(db, id);
  if (!existing) return null;
  const affectedPosts = await countTagPosts(db, id);
  await db.query(`DELETE FROM tags WHERE id = $1`, [id]);
  return { affectedPosts };
}
