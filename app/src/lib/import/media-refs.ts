// Rewrites archive-relative media references (`media/<key>`) back to the
// public `/media/<key>` URL shape (the exact inverse of
// lib/export/media-refs.ts's rewriteMediaLinks) — issue 002.
//
// Export always emits root-relative `media/<key>` refs (never `../media/...`,
// per docs/decisions/0003-content-export-format.md), so the inverse only needs
// to recognize that one shape. The regex requires `media/` to be preceded by
// start-of-string or a delimiter a Markdown/JSON author would actually use
// (whitespace, `(`, a quote char) so ordinary body prose that happens to
// contain the substring "media/" is not misrecognized as a reference.

const ARCHIVE_MEDIA_REF_RE = /(^|[\s("'])media\/([^\s")'<>\]]+)/g;

/** All distinct archive-relative media keys referenced anywhere in `text`. */
export function extractArchiveMediaKeys(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(ARCHIVE_MEDIA_REF_RE)) {
    seen.add(match[2]);
  }
  return [...seen];
}

/** Rewrite every `media/<key>` reference in `text` to the public `/media/<key>` URL. */
export function rewriteArchiveMediaLinksToPublic(text: string): string {
  return text.replace(ARCHIVE_MEDIA_REF_RE, (_match, pre: string, key: string) => `${pre}/media/${key}`);
}

/**
 * Rewrite a structured field's raw src string (e.g. coverImage.src), which is
 * the bare key text with no surrounding delimiter to anchor on. `null` passes
 * through unchanged; a value that is not the archive-relative shape (already
 * absolute, or an external URL) is left as-is.
 */
export function rewriteArchiveMediaSrc(src: string | null): string | null {
  if (src === null) return null;
  if (src.startsWith("media/")) return `/${src}`;
  return src;
}
