// Finds and rewrites /media/<key> references inside post/page body Markdown
// (and coverImage.src) so the export archive is self-contained (issue 001 —
// "copy media into the archive" decision).
//
// Media is served at the public /media/<key> route (see
// src/app/media/[...key]/route.ts) where <key> is an app-generated,
// slash-containing object-storage key such as "<uuid>/800.jpg" (see
// lib/media/upload.ts). A post body embeds these as ordinary Markdown image
// syntax, e.g. `![alt](/media/<uuid>/800.jpg)`; coverImage.src is the same
// shape as a structured field.

// Matches "/media/" followed by everything up to a character that cannot be
// part of a storage key: whitespace, the Markdown/HTML delimiters that close
// a link or attribute, or the string's end.
const MEDIA_REF_RE = /\/media\/([^\s")'<>\]]+)/g;

/** All distinct media storage keys referenced anywhere in `text` (order of first appearance). */
export function extractMediaKeys(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MEDIA_REF_RE)) {
    seen.add(match[1]);
  }
  return [...seen];
}

/**
 * Rewrite every `/media/<key>` reference in `text` to the archive-relative
 * path `media/<key>` (root-relative to the export archive, not the file that
 * contains the reference — documented in the frontmatter schema doc).
 */
export function rewriteMediaLinks(text: string): string {
  return text.replace(MEDIA_REF_RE, (_match, key: string) => `media/${key}`);
}
