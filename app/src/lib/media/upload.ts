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
import { createMedia } from "@/lib/content/media";
import type { Db } from "@/lib/db/types";
import type { MediaRef, ResponsiveSize } from "@/lib/content/types";
import type { MediaStorage } from "./storage";

const EXT_FOR_MIME: Record<ImageVariant["mimeType"], string> = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
};

export interface StoreImageInput {
  /** Raw uploaded image bytes (may carry EXIF/GPS — stripped before storage). */
  buffer: Buffer;
  /** Accessibility alt text captured from the upload UI. */
  alt?: string;
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
  const variants = await processImage(input.buffer, input.options);
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
