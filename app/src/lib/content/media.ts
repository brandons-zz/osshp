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
    createdAt: toIso(row.created_at),
  };
}

const MEDIA_COLUMNS = `id, storage_key, alt, mime_type, width, height, responsive_sizes, exif_stripped, created_at`;

export async function createMedia(
  db: Db,
  input: NewMediaRef,
): Promise<MediaRef> {
  const rows = await db.query<MediaRow>(
    `INSERT INTO media
       (storage_key, alt, mime_type, width, height, responsive_sizes, exif_stripped)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING ${MEDIA_COLUMNS}`,
    [
      input.storageKey,
      input.alt ?? "",
      input.mimeType ?? null,
      input.width ?? null,
      input.height ?? null,
      JSON.stringify(input.responsiveSizes ?? []),
      input.exifStripped ?? false,
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
