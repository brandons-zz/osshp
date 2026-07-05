// Markdown + YAML-frontmatter serialization for the content export (issue 001).
//
// THIS IS THE IMPORT CONTRACT (issue 002): the exact field set and shapes
// written here are what the forthcoming import service must be able to parse
// back losslessly. Full schema doc: docs/decisions/0002-content-export-format.md.
//
// Hand-rolled rather than a yaml dependency — same convention as the
// hand-assembled RSS XML in lib/content/feed.ts. Every value is emitted via
// JSON.stringify(), which is a valid subset of YAML flow scalars/collections
// (quoted strings, numbers, booleans, null, [...] arrays, {...} objects), so
// the output is real YAML any standard YAML parser can read — no custom
// osshp-specific parsing is required on the import side.

import type { Page, Post } from "@/lib/content/types";

/** The frontmatter delimiter line, matching the common `---` fenced convention. */
const FENCE = "---";

/**
 * Serialize an ordered set of frontmatter fields + a Markdown body into one
 * exported file's full text. Field order is fixed per content kind (see
 * postFrontmatterFields / pageFrontmatterFields) so exports are diff-stable.
 */
export function serializeMarkdownFile(
  fields: ReadonlyArray<readonly [string, unknown]>,
  body: string,
): string {
  const lines = fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `${FENCE}\n${lines.join("\n")}\n${FENCE}\n\n${body}\n`;
}

/**
 * Ordered frontmatter fields for a post/photo-post export. Every field is
 * always present (even when null/false) so the shape is predictable and the
 * export is lossless — omission would make "field absent" ambiguous with
 * "field is null/false".
 *
 * `coverImage.src`, each `post.gallery[].src`, and any `/media/<key>`
 * reference inside `body` MUST already be rewritten to archive-relative paths
 * (media/<key>) by the caller before this function runs — see
 * lib/export/media-refs.ts.
 *
 * `galleryCoverKey` (issue 050) is the archive-relative media key
 * (`media/<key>`) of the gallery's explicitly-chosen cover image, or `null`
 * when no explicit choice was made (`post.coverMediaId` is null — the store
 * then defaults to the first gallery image, and that default is exactly what
 * import restores when this field is null too). It is a separate argument
 * rather than something read off `post.coverMediaId` directly because a raw
 * DB id is not a portable identifier across instances — the archive-relative
 * media key is (see docs/decisions/0003-content-export-format.md).
 */
export function postFrontmatterFields(
  post: Post,
  galleryCoverKey: string | null = null,
): ReadonlyArray<readonly [string, unknown]> {
  return [
    ["title", post.title],
    ["slug", post.slug],
    ["type", post.type],
    ["status", post.status],
    ["tags", post.tags.map((t) => ({ name: t.name, slug: t.slug }))],
    ["publishDate", post.publishDate],
    ["createdAt", post.createdAt],
    ["updatedAt", post.updatedAt],
    ["excerpt", post.excerpt],
    ["coverImage", post.coverImage],
    ["panoramic", post.panoramic],
    ["showInBlog", post.showInBlog],
    ["featured", post.featured],
    ["isGallery", post.isGallery],
    [
      "gallery",
      post.gallery.map((g) => ({ src: g.src, alt: g.alt, caption: g.caption })),
    ],
    ["galleryCover", galleryCoverKey],
  ];
}

/** Ordered frontmatter fields for a page export. See postFrontmatterFields doc. */
export function pageFrontmatterFields(
  page: Page,
): ReadonlyArray<readonly [string, unknown]> {
  return [
    ["title", page.title],
    ["slug", page.slug],
    ["type", "page"],
    ["status", page.status],
    ["showInNav", page.showInNav],
    ["createdAt", page.createdAt],
    ["updatedAt", page.updatedAt],
  ];
}
