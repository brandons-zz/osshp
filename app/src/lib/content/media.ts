// Media reference store. Stores references to binaries held in Garage — never
// the binaries themselves. responsive_sizes and exif_stripped are modeled here;
// the resize + EXIF/GPS-strip pipeline that populates them is M2.4/M2.5.

import type { Db } from "@/lib/db/types";
import type { MediaRef, NewMediaRef, ResponsiveSize } from "./types";
import { toIso } from "./util";

interface MediaRow {
  id: string;
  storage_key: string;
  alt: string;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  responsive_sizes: ResponsiveSize[];
  exif_stripped: boolean;
  source_url: string | null;
  attribution: string | null;
  license: string | null;
  created_at: unknown;
}

function mapMedia(row: MediaRow): MediaRef {
  return {
    id: row.id,
    storageKey: row.storage_key,
    alt: row.alt,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    responsiveSizes: row.responsive_sizes ?? [],
    exifStripped: row.exif_stripped,
    sourceUrl: row.source_url ?? null,
    attribution: row.attribution ?? null,
    license: row.license ?? null,
    createdAt: toIso(row.created_at),
  };
}

const MEDIA_COLUMNS = `id, storage_key, alt, mime_type, width, height, responsive_sizes, exif_stripped, source_url, attribution, license, created_at`;

export async function createMedia(
  db: Db,
  input: NewMediaRef,
): Promise<MediaRef> {
  const rows = await db.query<MediaRow>(
    `INSERT INTO media
       (storage_key, alt, mime_type, width, height, responsive_sizes, exif_stripped, source_url, attribution, license)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     RETURNING ${MEDIA_COLUMNS}`,
    [
      input.storageKey,
      input.alt ?? "",
      input.mimeType ?? null,
      input.width ?? null,
      input.height ?? null,
      JSON.stringify(input.responsiveSizes ?? []),
      input.exifStripped ?? false,
      input.sourceUrl ?? null,
      input.attribution ?? null,
      input.license ?? null,
    ],
  );
  return mapMedia(rows[0]);
}

export async function getMediaById(
  db: Db,
  id: string,
): Promise<MediaRef | null> {
  const rows = await db.query<MediaRow>(
    `SELECT ${MEDIA_COLUMNS} FROM media WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapMedia(rows[0]) : null;
}

export async function getMediaByKey(
  db: Db,
  storageKey: string,
): Promise<MediaRef | null> {
  const rows = await db.query<MediaRow>(
    `SELECT ${MEDIA_COLUMNS} FROM media WHERE storage_key = $1`,
    [storageKey],
  );
  return rows[0] ? mapMedia(rows[0]) : null;
}

export async function listMedia(db: Db): Promise<MediaRef[]> {
  const rows = await db.query<MediaRow>(
    `SELECT ${MEDIA_COLUMNS} FROM media ORDER BY created_at DESC`,
  );
  return rows.map(mapMedia);
}

/**
 * Update the canonical alt text on a media record (issue 037 §1.3). Alt is
 * stored once per image; editing it here does NOT rewrite already-inserted body
 * alts — those are independent content captured at insert time (§6). Returns the
 * updated reference, or null if the id does not exist.
 */
export async function updateMediaAlt(
  db: Db,
  id: string,
  alt: string,
): Promise<MediaRef | null> {
  const rows = await db.query<MediaRow>(
    `UPDATE media SET alt = $2 WHERE id = $1 RETURNING ${MEDIA_COLUMNS}`,
    [id, alt.trim()],
  );
  return rows[0] ? mapMedia(rows[0]) : null;
}

/** Attribution fields writable after the fact (issue 077) — either by a future
 *  media-library edit affordance, or by content import restoring what an
 *  export's manifest recorded for a re-ingested image. `undefined` leaves a
 *  field untouched; `null` explicitly clears it. */
export interface MediaAttributionPatch {
  sourceUrl?: string | null;
  attribution?: string | null;
  license?: string | null;
}

/**
 * Patch attribution metadata on an existing media row (issue 077). Returns the
 * updated reference, or null if the id does not exist. A no-op patch (all
 * fields omitted) still round-trips the row unchanged.
 */
export async function updateMediaAttribution(
  db: Db,
  id: string,
  patch: MediaAttributionPatch,
): Promise<MediaRef | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.sourceUrl !== undefined) set("source_url", patch.sourceUrl);
  if (patch.attribution !== undefined) set("attribution", patch.attribution);
  if (patch.license !== undefined) set("license", patch.license);

  if (sets.length === 0) return getMediaById(db, id);

  params.push(id);
  const rows = await db.query<MediaRow>(
    `UPDATE media SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${MEDIA_COLUMNS}`,
    params,
  );
  return rows[0] ? mapMedia(rows[0]) : null;
}

/** The binary fields a replace (issue 037 §1.5) rewrites in place on the row. */
export interface MediaBinaryUpdate {
  storageKey: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  responsiveSizes: ResponsiveSize[];
}

/**
 * Rewrite the binary reference of an existing media row in place, keeping the
 * same id (issue 037 §1.5 replace). The id is stable so content references keep
 * resolving; only the variant set / dimensions / primary key change.
 */
export async function updateMediaBinary(
  db: Db,
  id: string,
  patch: MediaBinaryUpdate,
): Promise<MediaRef | null> {
  const rows = await db.query<MediaRow>(
    `UPDATE media
       SET storage_key = $2, mime_type = $3, width = $4, height = $5,
           responsive_sizes = $6::jsonb
     WHERE id = $1
     RETURNING ${MEDIA_COLUMNS}`,
    [
      id,
      patch.storageKey,
      patch.mimeType,
      patch.width,
      patch.height,
      JSON.stringify(patch.responsiveSizes),
    ],
  );
  return rows[0] ? mapMedia(rows[0]) : null;
}

/** Delete a media row (issue 037 §1.2). Object cleanup is the caller's job (the
 *  route removes every stored variant under the `<id>/` prefix first). Returns
 *  true if a row was removed. */
export async function deleteMedia(db: Db, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `DELETE FROM media WHERE id = $1 RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
