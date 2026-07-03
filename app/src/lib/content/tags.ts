// Tag store.

import type { Db } from "@/lib/db/types";
import type { Tag } from "./types";

interface TagRow {
  id: string;
  name: string;
  slug: string;
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
