// HEIC/HEIF → JPEG transcode (issue 048).
//
// The default sharp/libvips build ships WITHOUT HEIC (HEVC) decode for
// patent-licensing reasons, so `sharp(heicBytes).metadata()` throws. Browsers
// can't render HEIC either — so the correct move is to transcode a HEIC upload
// to a web format ONCE, at upload time, and feed that into the existing
// responsive-variant + EXIF-strip pipeline.
//
// We decode with `heic-convert` (a small ISC-licensed wrapper over the
// LGPL-3.0 `libheif-js` WASM build). It is DECODE-ONLY (libheif + the libde265
// HEVC *decoder*), and it re-encodes to JPEG via a pure-JS encoder — so there is
// NO x265 HEVC *encoder* in the image, avoiding that encoder's patent exposure.
// libheif-js is WASM, so it runs unchanged under Bun on the alpine runtime with
// no native musl build step.
//
// Privacy note (design §8): heic-convert emits a bare JPEG from the decoded
// pixels — it does NOT copy the source EXIF/GPS. The downstream processImage
// then strips metadata again by default. So a GPS-tagged iPhone HEIC cannot leak
// its location through the stored variants. Verified by test.

import convert from "heic-convert";
import { sniffImageFormat, isHeicFormat } from "./detect";

/**
 * Transcode HEIC/HEIF bytes to a JPEG buffer sharp can decode. Throws if the
 * input is not decodable HEIC (the caller classifies first, so this is only
 * reached for real HEIC input).
 */
export async function transcodeHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  const out = await convert({ buffer, format: "JPEG", quality: 0.92 });
  return Buffer.from(out);
}

/**
 * Return a buffer the responsive pipeline (sharp) can decode: HEIC/HEIF is
 * transcoded to JPEG; every other format is returned unchanged. The optional
 * filename is a fallback signal when the magic bytes are unrecognized but the
 * name ends in `.heic`/`.heif`.
 */
export async function ensureProcessable(
  buffer: Buffer,
  filename?: string,
): Promise<Buffer> {
  const sniffed = sniffImageFormat(buffer.subarray(0, 32));
  const heicByExt = filename ? /\.(heic|heif)$/i.test(filename) : false;
  if (isHeicFormat(sniffed) || (sniffed === null && heicByExt)) {
    return transcodeHeicToJpeg(buffer);
  }
  return buffer;
}
