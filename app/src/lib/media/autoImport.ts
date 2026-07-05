// Auto-import external inline images (issue 077).
//
// The strict `img-src 'self' data:` CSP (lib/security/headers.ts) blocks any
// `![alt](https://other-host/…)` markdown image from ever rendering — that
// CSP stays strict (local hosting, no third-party traffic leaking, is the
// whole point). This module is the fix: at post/page save time, scan the body
// for markdown images whose URL is an EXTERNAL http(s) address, fetch each one
// through the SSRF-bounded pipeline (externalFetch.ts + ssrf.ts), re-encode it
// through the SAME upload pipeline every manual upload goes through
// (processor.ts's EXIF/GPS strip + responsive variants), store it, and
// rewrite the body's URL to the new same-origin `/media/<key>` reference.
//
// Idempotent by construction: once a URL is rewritten to `/media/…` it is no
// longer external, so re-saving the same post never re-fetches it.
//
// Never drops content and never fails the save: a fetch/validation/processing
// failure for one image leaves that image's ORIGINAL URL untouched in the
// body and records a "failed" report entry with a clear reason — the caller
// (the admin write routes) surfaces the report to the author.

import { randomUUID } from "node:crypto";
import { fetchExternalImage, type ExternalFetchDeps } from "./externalFetch";
import { classifyUpload } from "./detect";
import { ensureProcessable } from "./heic";
import { processImage, type ImageVariant } from "./processor";
import { createMedia } from "@/lib/content/media";
import type { Db } from "@/lib/db/types";
import type { MediaStorage } from "./storage";

const EXT_FOR_MIME: Record<ImageVariant["mimeType"], string> = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
};

export type ImageImportOutcome = "imported" | "failed";

export interface ImageImportResult {
  /** The external URL as it appeared in the markdown before this pass. */
  url: string;
  outcome: ImageImportOutcome;
  /** The new same-origin URL — present only when outcome === "imported". */
  mediaUrl?: string;
  /** A clear, author-facing explanation — present only when outcome === "failed". */
  reason?: string;
}

export interface AutoImportResult {
  /** The body with every successfully-imported URL (and its title, credited
   *  with the source) rewritten in place. Unchanged when nothing external
   *  was found, or when every external image failed to import. */
  body: string;
  /** One entry per distinct external image URL found — never populated for
   *  already-local (`/media/…`) or `data:` images, since there is nothing to
   *  do for those (the idempotency guarantee). */
  report: ImageImportResult[];
}

// Matches a markdown image: ![alt](url "optional title"). This only needs to
// FIND image syntax to decide what to fetch/rewrite — the sanitize.ts
// pipeline (via remark/rehype) remains the sole source of truth for what
// actually renders; this regex is not a markdown parser.
const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)/g;

function isExternalHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function safeFilenameFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    return pathname.split("/").filter(Boolean).pop() || "image";
  } catch {
    return "image";
  }
}

/** The credited title written back into the body markdown on a successful
 *  import: the author's own caption (if any) plus the original source URL,
 *  which the render pipeline (sanitize.ts) auto-links inside the figcaption —
 *  this is what makes "linked source credit" work with zero extra markdown
 *  syntax and zero render-time DB lookups (the caption is pure markdown text,
 *  round-tripping through export/import for free). */
function creditedTitle(authorTitle: string | undefined, sourceUrl: string): string {
  const trimmed = authorTitle?.trim();
  return trimmed ? `${trimmed} — Source: ${sourceUrl}` : `Source: ${sourceUrl}`;
}

async function importOneImage(
  db: Db,
  storage: MediaStorage,
  url: string,
  authorTitle: string | undefined,
  deps: ExternalFetchDeps,
): Promise<ImageImportResult> {
  const fetched = await fetchExternalImage(url, deps);
  if (!fetched.ok) {
    return { url, outcome: "failed", reason: fetched.reason };
  }

  // Never trust the response Content-Type header alone. classifyUpload()'s
  // `.accept` is satisfied by a declared MIME type OR a filename extension
  // alone (the right call for a browser-originated upload) — but the
  // declared Content-Type on a FETCHED response is server-controlled, i.e.
  // exactly what an attacker could lie about. For this path we require the
  // stronger signal: `.sniffed` is set only when the actual magic bytes
  // matched a known image container, independent of whatever the response
  // claimed.
  const filename = safeFilenameFromUrl(url);
  const classification = classifyUpload({
    declaredType: fetched.contentType,
    filename,
    head: fetched.buffer.subarray(0, 32),
  });
  if (!classification.sniffed) {
    return {
      url,
      outcome: "failed",
      reason: "the URL did not return a recognizable image",
    };
  }

  try {
    const processable = await ensureProcessable(fetched.buffer, filename);
    const variants = await processImage(processable); // default widths; EXIF/GPS strip on
    if (variants.length === 0) {
      return { url, outcome: "failed", reason: "the image could not be processed" };
    }
    const id = randomUUID();
    const sizes: Array<{ width: number; height: number; key: string }> = [];
    for (const v of variants) {
      const key = `${id}/${v.width}.${EXT_FOR_MIME[v.mimeType]}`;
      await storage.put(key, v.buffer, v.mimeType);
      sizes.push({ width: v.width, height: v.height, key });
    }
    const primary = sizes.reduce((a, b) => (b.width > a.width ? b : a), sizes[0]);
    await createMedia(db, {
      storageKey: primary.key,
      mimeType: variants[0].mimeType,
      width: primary.width,
      height: primary.height,
      responsiveSizes: sizes,
      exifStripped: true,
      sourceUrl: url,
      attribution: authorTitle?.trim() || null,
    });
    return { url, outcome: "imported", mediaUrl: `/media/${primary.key}` };
  } catch (e) {
    return {
      url,
      outcome: "failed",
      reason: `could not process the fetched image: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Scan `body` for markdown images whose URL is an external http(s) address,
 * import each distinct one through the SSRF-bounded pipeline, and rewrite the
 * body in place. `deps` is test-only wiring for the SSRF fetch (see
 * externalFetch.ts) — production callers always omit it.
 */
export async function autoImportExternalImages(
  db: Db,
  storage: MediaStorage,
  body: string,
  deps: ExternalFetchDeps = {},
): Promise<AutoImportResult> {
  const matches = [...body.matchAll(MD_IMAGE_RE)];
  const report: ImageImportResult[] = [];
  if (matches.length === 0) return { body, report };

  // De-duplicate by URL: the same external image embedded twice is fetched
  // once, and every occurrence is rewritten identically.
  const resultByUrl = new Map<string, ImageImportResult>();
  let out = body;

  for (const m of matches) {
    const [full, alt, url, title] = m;
    if (!isExternalHttpUrl(url)) continue; // already /media/, data:, or relative — nothing to do

    let result = resultByUrl.get(url);
    if (!result) {
      result = await importOneImage(db, storage, url, title, deps);
      resultByUrl.set(url, result);
      report.push(result);
    }
    if (result.outcome === "imported" && result.mediaUrl) {
      const replacement = `![${alt}](${result.mediaUrl} "${creditedTitle(title, url)}")`;
      out = out.replace(full, replacement);
    }
  }

  return { body: out, report };
}
