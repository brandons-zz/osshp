// Media upload pipeline (M2.9): raw image bytes → EXIF/GPS-stripped responsive
// variants (via the M2.7 processor) → object store (Garage) → a media-table
// reference linked to content by its public URL.
//
// PRIVACY FLOOR (design §8): the variants come from processImage, which strips
// EXIF/GPS by default. The raw upload (which may carry GPS) is NEVER stored — only
// the stripped variants are persisted. So a travel photo's location cannot leak
// through the stored objects by construction.
//
// SSRF (A10): this pipeline accepts uploaded BYTES only. There is no media-by-URL
// / server-side remote fetch path here; a URL-import would need an egress guard
// and is deliberately out of scope.
//
// Server-only (uses node:crypto + the storage seam).

import { randomUUID } from "node:crypto";
import { processImage, type ImageVariant, type ProcessorOptions } from "./processor";
import { ensureProcessable } from "./heic";
import { createMedia, getMediaById, updateMediaBinary } from "@/lib/content/media";
import type { Db } from "@/lib/db/types";
import type { MediaRef, ResponsiveSize } from "@/lib/content/types";
import type { MediaStorage } from "./storage";

const EXT_FOR_MIME: Record<ImageVariant["mimeType"], string> = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
};

export interface StoreImageInput {
  /** Raw uploaded image bytes (may carry EXIF/GPS — stripped before storage).
   *  HEIC/HEIF bytes are transcoded to JPEG before the pipeline (issue 048). */
  buffer: Buffer;
  /** Accessibility alt text captured from the upload UI. */
  alt?: string;
  /** Original filename — a fallback HEIC signal when the magic bytes are odd. */
  filename?: string;
  /** Widths/format overrides; EXIF/GPS strip stays default-on (the privacy floor). */
  options?: ProcessorOptions;
}

export interface StoredImage {
  /** The persisted media reference (responsive variants + dimensions + alt). */
  media: MediaRef;
  /** Public URL of the primary (largest) variant — what content links to. */
  url: string;
}

/**
 * Process an uploaded image into responsive, EXIF/GPS-stripped variants, store
 * each in object storage, and persist a single media reference linking them.
 *
 * The returned `url` (`/media/<key>`) is the demonstrable link: a post's cover
 * image (or any content reference) points at it, and the media-serve route streams
 * the bytes back so the image renders on the public site through the theme.
 */
export async function storeUploadedImage(
  db: Db,
  storage: MediaStorage,
  input: StoreImageInput,
): Promise<StoredImage> {
  // Transcode HEIC/HEIF → JPEG up front (the default sharp build can't decode
  // it); every other format passes through untouched (issue 048).
  const processable = await ensureProcessable(input.buffer, input.filename);
  const variants = await processImage(processable, input.options);
  if (variants.length === 0) {
    throw new Error("image produced no variants");
  }

  const id = randomUUID();
  const sizes: ResponsiveSize[] = [];
  for (const v of variants) {
    const key = `${id}/${v.width}.${EXT_FOR_MIME[v.mimeType]}`;
    await storage.put(key, v.buffer, v.mimeType);
    sizes.push({ width: v.width, height: v.height, key });
  }

  // Primary = the largest variant (best quality for a cover render; the smaller
  // entries in responsiveSizes are available for srcset wiring later).
  const primary = sizes.reduce((a, b) => (b.width > a.width ? b : a), sizes[0]);

  const media = await createMedia(db, {
    storageKey: primary.key,
    alt: input.alt ?? "",
    mimeType: variants[0].mimeType,
    width: primary.width,
    height: primary.height,
    responsiveSizes: sizes,
    // strip is on unless a caller explicitly opted out (the default never does).
    exifStripped: input.options?.stripExif !== false,
  });

  return { media, url: `/media/${primary.key}` };
}

export interface ReplacedImage {
  /** The media reference after the in-place rewrite (same id). */
  media: MediaRef;
  /** Public URL of the NEW primary variant. */
  url: string;
  /** Public URL of the OLD primary variant (for the reference-rewrite). */
  oldPrimaryUrl: string;
  /** Every OLD reference URL (primary + variant siblings) — the rewrite set so a
   *  body that embedded a non-primary variant is re-pointed too (issue 039). */
  oldUrls: string[];
}

/**
 * Replace the binary of an existing media upload IN PLACE, keeping the same id
 * (issue 037 §1.5 / §7). New EXIF/GPS-stripped variants are processed and stored
 * under the same `<id>/` prefix, the media row is rewritten (new
 * responsive_sizes / dimensions / primary key), and any OLD variant object that
 * the new upload does not reproduce is pruned. The alt text is preserved (a
 * replace swaps pixels, never the author's description).
 *
 * Order is chosen so the image never 404s during the swap: new objects are
 * stored FIRST, then the row is updated, and only stale old objects are deleted
 * LAST. The caller (the replace route) rewrites content references from
 * `oldPrimaryUrl` to `url` using the §5 scan.
 */
export async function replaceUploadedImage(
  db: Db,
  storage: MediaStorage,
  mediaId: string,
  input: Pick<StoreImageInput, "buffer" | "options" | "filename">,
): Promise<ReplacedImage | null> {
  const existing = await getMediaById(db, mediaId);
  if (!existing) return null;

  // Reuse the EXISTING object-store prefix (the first segment of the current
  // storage key), NOT media.id — the prefix is the anchor content references use
  // (§5 note). Keeping it stable means existing `/media/<prefix>/…` references
  // continue to resolve; only the width-bearing filename of the primary changes.
  const prefix = existing.storageKey.split("/")[0];

  // HEIC/HEIF replacements are transcoded too (issue 048) so a photo can be
  // swapped for an iPhone HEIC without failing the decode.
  const processable = await ensureProcessable(input.buffer, input.filename);
  const variants = await processImage(processable, input.options);
  if (variants.length === 0) {
    throw new Error("image produced no variants");
  }

  const newSizes: ResponsiveSize[] = [];
  for (const v of variants) {
    const key = `${prefix}/${v.width}.${EXT_FOR_MIME[v.mimeType]}`;
    await storage.put(key, v.buffer, v.mimeType);
    newSizes.push({ width: v.width, height: v.height, key });
  }
  const newPrimary = newSizes.reduce(
    (a, b) => (b.width > a.width ? b : a),
    newSizes[0],
  );

  const media = await updateMediaBinary(db, mediaId, {
    storageKey: newPrimary.key,
    mimeType: variants[0].mimeType,
    width: newPrimary.width,
    height: newPrimary.height,
    responsiveSizes: newSizes,
  });
  if (!media) return null;

  // Prune old variant objects the new upload did not reproduce (same width+ext
  // keys are overwritten in place above and must NOT be deleted).
  const newKeys = new Set(newSizes.map((s) => s.key));
  const oldKeys = new Set<string>([
    existing.storageKey,
    ...existing.responsiveSizes.map((s) => s.key),
  ]);
  for (const key of oldKeys) {
    if (!newKeys.has(key)) await storage.delete(key);
  }

  const oldUrls = Array.from(
    new Set(
      [existing.storageKey, ...existing.responsiveSizes.map((s) => s.key)].map(
        (k) => `/media/${k}`,
      ),
    ),
  );

  return {
    media,
    url: `/media/${newPrimary.key}`,
    oldPrimaryUrl: `/media/${existing.storageKey}`,
    oldUrls,
  };
}
