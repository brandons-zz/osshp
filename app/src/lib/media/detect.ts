// Content-based image detection (issue 048).
//
// Why sniff bytes instead of trusting the MIME type: iOS hands a HEIC photo to
// the browser with an EMPTY or `application/octet-stream` MIME surprisingly
// often, so a `file.type.startsWith("image/")` gate false-rejects a genuine
// iPhone photo before its bytes are ever inspected. We instead identify images
// by their magic bytes (with a filename-extension fallback), which is both more
// permissive toward real images with odd MIMEs and still rejects true non-images.
//
// Pure/synchronous byte inspection — no decode, no dependency. The HEIC decode
// itself lives in ./heic (heic-convert / libheif-WASM); this module only decides
// "is this an image, and is it HEIC?".

/** Image container formats we can identify from magic bytes. */
export type SniffedFormat =
  | "jpeg"
  | "png"
  | "gif"
  | "webp"
  | "avif"
  | "tiff"
  | "heic"
  | "heif";

// ISO-BMFF (`ftyp`) brands. HEIC = HEVC-coded HEIF; plain HEIF/`mif1` may still
// carry HEVC image items, so we treat both as "needs transcode" downstream.
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx"]);
const HEIF_BRANDS = new Set(["mif1", "msf1", "heif"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/** Filenames that look like an image by extension (last-resort accept signal). */
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|tiff?|heic|heif)$/i;
/** HEIC/HEIF by extension — used when the MIME is blank and bytes are ambiguous. */
const HEIC_EXT_RE = /\.(heic|heif)$/i;

/**
 * Identify an image container from its leading bytes. Returns null when the head
 * matches no known image signature. Only needs the first ~32 bytes.
 */
export function sniffImageFormat(head: Buffer): SniffedFormat | null {
  if (head.length < 12) return null;

  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return "png";
  }
  // GIF: "GIF8"
  if (
    head[0] === 0x47 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x38
  ) {
    return "gif";
  }
  // WEBP: "RIFF"...."WEBP"
  if (
    head.toString("ascii", 0, 4) === "RIFF" &&
    head.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  // TIFF: "II*\0" (little-endian) or "MM\0*" (big-endian)
  if (
    (head[0] === 0x49 &&
      head[1] === 0x49 &&
      head[2] === 0x2a &&
      head[3] === 0x00) ||
    (head[0] === 0x4d &&
      head[1] === 0x4d &&
      head[2] === 0x00 &&
      head[3] === 0x2a)
  ) {
    return "tiff";
  }
  // ISO-BMFF (HEIC / HEIF / AVIF): "ftyp" box at offset 4, major brand at 8.
  if (head.toString("ascii", 4, 8) === "ftyp") {
    const brand = head.toString("ascii", 8, 12);
    if (HEIC_BRANDS.has(brand)) return "heic";
    if (AVIF_BRANDS.has(brand)) return "avif";
    if (HEIF_BRANDS.has(brand)) return "heif";
    // Some encoders set an unhelpful major brand (e.g. "mif1") and record the
    // real codec only in the compatible-brands list that follows — scan it.
    const compat = head.toString("ascii", 16, Math.min(head.length, 32));
    if (/heic|heix|hevc/.test(compat)) return "heic";
    if (/avif/.test(compat)) return "avif";
    if (/mif1|heif|msf1/.test(compat)) return "heif";
  }
  return null;
}

/** True for the HEIC/HEIF family, which the default sharp/libvips build cannot
 *  decode and must therefore be transcoded before the responsive pipeline. */
export function isHeicFormat(format: SniffedFormat | null): boolean {
  return format === "heic" || format === "heif";
}

export interface UploadClassification {
  /** Accept this upload as an image (proceed to the pipeline). */
  accept: boolean;
  /** The sniffed container format, or null if unrecognized. */
  sniffed: SniffedFormat | null;
  /** The bytes are HEIC/HEIF and must be transcoded before sharp sees them. */
  isHeic: boolean;
}

/**
 * Decide whether an upload should be accepted as an image, and whether it needs
 * HEIC transcoding — from bytes first, MIME and extension as fallbacks.
 *
 * Accept when ANY of: a known image signature is sniffed, the declared MIME is
 * `image/*`, or the filename carries an image extension. A genuine non-image
 * (no signature, no image MIME, no image extension) is rejected here; anything
 * that slips through still fails in the decoder with a clear message.
 */
export function classifyUpload(opts: {
  declaredType: string;
  filename: string;
  head: Buffer;
}): UploadClassification {
  const sniffed = sniffImageFormat(opts.head);
  const byMime = opts.declaredType.startsWith("image/");
  const byExt = IMAGE_EXT_RE.test(opts.filename);

  const heicByMime = /^image\/(heic|heif)/i.test(opts.declaredType);
  const heicByExt = HEIC_EXT_RE.test(opts.filename);
  // Trust sniffed bytes first; fall back to MIME/extension only when the head
  // was unrecognized (e.g. a truncated head that still declared HEIC).
  const isHeic =
    isHeicFormat(sniffed) || (sniffed === null && (heicByMime || heicByExt));

  return { accept: byMime || sniffed !== null || byExt, sniffed, isHeic };
}
