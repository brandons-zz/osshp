// Page store (spec §8 About/portfolio). Mirrors the post status model so the
// published-only theme boundary applies to pages too: getPublishedPageBySlug
// returns only status='published' pages.

import type { Db } from "@/lib/db/types";
import type { NewPage, Page, PageUpdate } from "./types";
import { toIso } from "./util";

interface PageRow {
  id: string;
  title: string;
  slug: string;
  body: string;
  status: Page["status"];
  show_in_nav: boolean;
  created_at: unknown;
  updated_at: unknown;
}

function mapPage(row: PageRow): Page {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    body: row.body,
    status: row.status,
    showInNav: row.show_in_nav,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const PAGE_COLUMNS = `id, title, slug, body, status, show_in_nav, created_at, updated_at`;

export async function createPage(db: Db, input: NewPage): Promise<Page> {
  // created_at/updated_at: COALESCE to the DB's now() default when the caller
  // omits them (the normal authoring path); content import (issue 002) passes
  // the source's original timestamps to preserve them on a lossless round-trip.
  const rows = await db.query<PageRow>(
    `INSERT INTO pages (title, slug, body, status, show_in_nav, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), COALESCE($7, now()))
     RETURNING ${PAGE_COLUMNS}`,
    [
      input.title,
      input.slug,
      input.body,
      input.status ?? "draft",
      input.showInNav ?? false,
      input.createdAt ?? null,
      input.updatedAt ?? null,
    ],
  );
  return mapPage(rows[0]);
}

export async function getPageById(db: Db, id: string): Promise<Page | null> {
  const rows = await db.query<PageRow>(
    `SELECT ${PAGE_COLUMNS} FROM pages WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapPage(rows[0]) : null;
}

export async function getPageBySlug(
  db: Db,
  slug: string,
): Promise<Page | null> {
  const rows = await db.query<PageRow>(
    `SELECT ${PAGE_COLUMNS} FROM pages WHERE slug = $1`,
    [slug],
  );
  return rows[0] ? mapPage(rows[0]) : null;
}

export async function listPages(db: Db): Promise<Page[]> {
  const rows = await db.query<PageRow>(
    `SELECT ${PAGE_COLUMNS} FROM pages ORDER BY title`,
  );
  return rows.map(mapPage);
}

export async function updatePage(
  db: Db,
  id: string,
  patch: PageUpdate,
): Promise<Page | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (patch.title !== undefined) set("title", patch.title);
  if (patch.slug !== undefined) set("slug", patch.slug);
  if (patch.body !== undefined) set("body", patch.body);
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.showInNav !== undefined) set("show_in_nav", patch.showInNav);
  if (patch.createdAt !== undefined) set("created_at", patch.createdAt);
  // Import's "overwrite existing" mode (issue 002) passes an explicit
  // updatedAt to restore the source's original value; every other caller
  // omits it and gets the normal stamp-at-write-time auto-update below.
  if (patch.updatedAt !== undefined) set("updated_at", patch.updatedAt);

  if (sets.length === 0) return getPageById(db, id);

  if (patch.updatedAt === undefined) sets.push(`updated_at = now()`);
  params.push(id);
  const rows = await db.query<PageRow>(
    `UPDATE pages SET ${sets.join(", ")} WHERE id = $${params.length}
     RETURNING ${PAGE_COLUMNS}`,
    params,
  );
  return rows[0] ? mapPage(rows[0]) : null;
}

export async function deletePage(db: Db, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `DELETE FROM pages WHERE id = $1 RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

// ── Published-only reads (theme materialization boundary, §3.3) ────────────

export async function getPublishedPageBySlug(
  db: Db,
  slug: string,
): Promise<Page | null> {
  const rows = await db.query<PageRow>(
    `SELECT ${PAGE_COLUMNS} FROM pages WHERE slug = $1 AND status = 'published'`,
    [slug],
  );
  return rows[0] ? mapPage(rows[0]) : null;
}

/** Published pages only — source for the sitemap. */
export async function listPublishedPages(db: Db): Promise<Page[]> {
  const rows = await db.query<PageRow>(
    `SELECT ${PAGE_COLUMNS} FROM pages WHERE status = 'published' ORDER BY title`,
  );
  return rows.map(mapPage);
}

/**
 * Published pages with show_in_nav=true — merged into the site nav at render time (V-010).
 * Ordered by title for a deterministic, predictable nav order.
 */
export async function listPublishedPagesForNav(db: Db): Promise<Page[]> {
  const rows = await db.query<PageRow>(
    `SELECT ${PAGE_COLUMNS} FROM pages WHERE status = 'published' AND show_in_nav = true ORDER BY title`,
  );
  return rows.map(mapPage);
}
