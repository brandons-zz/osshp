// Image processing service: responsive resize + EXIF/GPS strip.
//
// EXIF/GPS stripping is the default — the non-negotiable privacy floor for
// travel-photo uploads (design §8). Callers that genuinely need to preserve
// metadata must pass { stripExif: false } explicitly.
//
// This service produces image buffers only. Storage-key assignment and
// object-store upload are handled by the M2.9 media upload pipeline.
// The ResponsiveSize records that land in the media table come from wiring
// these buffers through Garage — that is not this module's concern.

import sharp from "sharp";

/**
 * One generated responsive variant produced by processImage.
 *
 * storage_key is NOT assigned here; that is the M2.9 upload pipeline's job.
 * The buffer + dimensions are everything the upload layer needs to store the
 * variant and populate a ResponsiveSize record in the media table.
 */
export interface ImageVariant {
  /** Processed image bytes, ready for upload to object storage. */
  buffer: Buffer;
  /** Output width in pixels (may differ slightly from the requested width due
   *  to rounding in the aspect-ratio calculation). */
  width: number;
  /** Output height in pixels (scaled proportionally from the source). */
  height: number;
  /** MIME type of the output buffer (matches the requested format). */
  mimeType: "image/jpeg" | "image/webp" | "image/avif";
}

export interface ProcessorOptions {
  /**
   * Target widths for responsive size variants (pixels).
   *
   * Sharp downscales to each requested width while preserving aspect ratio.
   * Widths that exceed the source image width are skipped (no upscaling —
   * enlarging degrades quality and wastes bytes). If every requested width
   * exceeds the source, a single variant at the native source width is
   * returned instead.
   *
   * Defaults to [400, 800, 1600].
   */
  widths?: number[];

  /**
   * Strip all EXIF/GPS metadata from every output variant.
   *
   * Defaults to true — the privacy floor for travel photos. Set to false only
   * when the caller has a deliberate reason to preserve metadata.
   *
   * Implementation note: sharp strips metadata by default (no .withMetadata()
   * call). Preservation requires an explicit opt-in via .withMetadata().
   */
  stripExif?: boolean;

  /**
   * Output image format.
   * Defaults to "jpeg".
   */
  format?: "jpeg" | "webp" | "avif";
}

/** Default responsive widths (pixels). */
export const DEFAULT_WIDTHS: readonly number[] = [400, 800, 1600];

/** Default output format. */
export const DEFAULT_FORMAT = "jpeg" as const;

/**
 * Generate responsive size variants from a raw image buffer.
 *
 * EXIF/GPS metadata is stripped from every output variant by default (the
 * privacy guarantee for travel-photo uploads — pass { stripExif: false }
 * to preserve it).
 *
 * Variants whose width would exceed the source image are silently skipped to
 * avoid upscaling. At least one variant is always returned (the source width,
 * if all requested targets are too large).
 *
 * Callable by the M2.9 media upload pipeline (Uppy + Garage wiring).
 *
 * @param input  Raw image bytes (JPEG, PNG, WebP, AVIF, TIFF, …).
 * @param opts   Widths, output format, and the EXIF/GPS strip flag.
 * @returns      Processed buffers with dimensions, one per target width.
 */
export async function processImage(
  input: Buffer,
  opts: ProcessorOptions = {},
): Promise<ImageVariant[]> {
  const {
    widths = [...DEFAULT_WIDTHS],
    stripExif = true,
    format = DEFAULT_FORMAT,
  } = opts;

  // Probe the source once to get its native dimensions.
  const { width: srcWidth = 0 } = await sharp(input).metadata();

  // Skip widths that exceed the source (no upscaling).
  const filtered = widths.filter((w) => w <= srcWidth);
  // Guarantee at least one variant even when every target exceeds the source.
  const targets = filtered.length > 0 ? filtered : [srcWidth];

  return Promise.all(
    targets.map(async (targetWidth): Promise<ImageVariant> => {
      let pipeline = sharp(input).resize({
        width: targetWidth,
        withoutEnlargement: true,
      });

      // Preserve metadata only on explicit opt-in.
      // When stripExif is true (the default), sharp's default metadata-free
      // output gives us the EXIF/GPS strip for free — no extra step required.
      if (!stripExif) {
        pipeline = pipeline.withMetadata();
      }

      let buffer: Buffer;
      let mimeType: ImageVariant["mimeType"];

      switch (format) {
        case "webp":
          buffer = await pipeline.webp().toBuffer();
          mimeType = "image/webp";
          break;
        case "avif":
          buffer = await pipeline.avif().toBuffer();
          mimeType = "image/avif";
          break;
        default:
          buffer = await pipeline.jpeg().toBuffer();
          mimeType = "image/jpeg";
      }

      // Re-probe to get exact output dimensions — sharp rounds on resize.
      const { width, height } = await sharp(buffer).metadata();
      return { buffer, width: width!, height: height!, mimeType };
    }),
  );
}
