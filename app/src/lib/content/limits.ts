// Content title/slug length bounds (issue 072).
//
// GET /api/admin/export builds `posts/<slug>.md` / `pages/<slug>.md` archive
// paths and hands them to the hand-rolled USTAR writer (lib/export/tar.ts).
// USTAR splits a path into a `name` field (<=100 bytes) and a `prefix` field
// (<=155 bytes) at the LAST "/" in the path; "posts/"/"pages/" contain no
// other "/", so the only possible split point puts the entire `<slug>.md`
// tail in the 100-byte name field. A slug whose UTF-8 byte length pushes that
// tail past 100 bytes makes splitUstarPath() return null and buildHeader()
// throw — and since neither the blog/pages/photos create routes nor the DB
// column bounded slug length, that state was reachable with a single POST.
//
// Enforced at BOTH create and update time (both surfaces write the same slug
// column) so a post/page can never reach a state that later breaks the
// exporter. This is the primary fix; exporter.ts also degrades gracefully on
// a not-representable path (defense in depth for any pre-existing row).

/** Comfortably under the ~97-byte hard ceiling derived above (slug + ".md" <= 100). */
export const MAX_SLUG_BYTES = 80;

/** Not tar-relevant (title isn't part of the archive path) — a sane editorial
 *  ceiling so a pasted/auto-slugified title can't grow unbounded either. */
export const MAX_TITLE_LENGTH = 200;

/**
 * Validate title/slug length, returning a user-facing error string, or null
 * when both are within bounds. Callers pass only the fields being set —
 * `undefined` (an update route omitting the field) is always valid.
 */
export function validateTitleSlugLength(
  title: string | undefined,
  slug: string | undefined,
): string | null {
  if (title !== undefined && title.length > MAX_TITLE_LENGTH) {
    return `title must be ${MAX_TITLE_LENGTH} characters or fewer`;
  }
  if (slug !== undefined && Buffer.byteLength(slug, "utf8") > MAX_SLUG_BYTES) {
    return `slug must be ${MAX_SLUG_BYTES} bytes or fewer`;
  }
  return null;
}
