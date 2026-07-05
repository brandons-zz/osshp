// Tag store.

import type { Db } from "@/lib/db/types";
import type { Tag } from "./types";
import { VISIBLE_FILTER } from "./posts";

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
