// Import orchestration (issue 002) — the counterpart to lib/export/exporter.ts.
//
// One entry point, importSource(), consumed by both the admin route and the
// CLI (same "one source of truth, two callers" shape the export module uses).
//
// Mode semantics (chosen by the importer at import time, issue 002 AC):
//   skip      — an existing slug is left untouched; reported skipped.
//   overwrite — an existing slug's content is replaced in place (including
//               its original createdAt/updatedAt, for a lossless restore);
//               absent -> created.
//   create    — always creates a new row; a colliding slug is disambiguated
//               (-2, -3, ...) rather than silently duplicating or clobbering.
//
// Media is ingested BEFORE any post/page is written, so every body/coverImage
// rewrite below can tell whether the reference actually resolves.

import {
  createPage,
  createPost,
  getMediaByKey,
  createMedia,
  getPageBySlug,
  getPostBySlug,
  updatePage,
  updatePost,
} from "@/lib/content";
import type { NewPage, NewPost, PageUpdate, PostUpdate } from "@/lib/content/types";
import type { Db } from "@/lib/db/types";
import type { MediaStorage } from "@/lib/media";
import { isFrontmatterParseError, parseMarkdownFile } from "./frontmatter";
import {
  extractArchiveMediaKeys,
  rewriteArchiveMediaLinksToPublic,
  rewriteArchiveMediaSrc,
} from "./media-refs";
import { classifyAndValidate, type ClassifyHint } from "./schema";
import { nextAvailableSlug } from "./slug";
import { isSafeArchivePath } from "./tar-reader";
import type {
  ImportItemResult,
  ImportMode,
  ImportReport,
  ImportSource,
  ValidatedPage,
  ValidatedPost,
} from "./types";
import type { SourceEntryError } from "./source";

const MAX_STORAGE_KEY_BYTES = 1024; // matches common S3-compatible key length limits

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  png: "image/png",
  gif: "image/gif",
};

function mimeForKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

/**
 * Copy every media file the source provides into object storage and ensure a
 * media-table row exists for it. Returns the count successfully ingested plus
 * any keys that failed (defense-in-depth path/size checks, or a storage
 * error) — failures are reported, not thrown, so one bad media file cannot
 * abort the batch.
 */
async function ingestMedia(
  db: Db,
  storage: MediaStorage,
  mediaFiles: ReadonlyMap<string, Buffer>,
): Promise<{ importedCount: number; failedKeys: string[] }> {
  let importedCount = 0;
  const failedKeys: string[] = [];
  for (const [key, bytes] of mediaFiles) {
    // Defense in depth: source.ts/tar-reader.ts already validated the archive
    // path this key was derived from, but re-check the key itself before it
    // becomes a storage write target.
    if (!isSafeArchivePath(key) || Buffer.byteLength(key, "utf8") > MAX_STORAGE_KEY_BYTES) {
      failedKeys.push(key);
      continue;
    }
    try {
      await storage.put(key, bytes, mimeForKey(key));
      const existing = await getMediaByKey(db, key);
      if (!existing) {
        await createMedia(db, {
          storageKey: key,
          mimeType: mimeForKey(key),
          // These variants are, by the export contract, already the stripped
          // output of the upload pipeline (upload.ts never stores raw bytes) —
          // true is the accurate default for content round-tripped through our
          // own export. Width/height/alt are not carried in the archive shape
          // (docs/decisions/0003-content-export-format.md); left unknown.
          exifStripped: true,
        });
      }
      importedCount++;
    } catch {
      failedKeys.push(key);
    }
  }
  return { importedCount, failedKeys };
}

/** Media keys referenced by `body`/`coverImageSrc` that the source did NOT
 *  provide bytes for — mirrors export's manifest.mediaErrors shape. */
function collectMissingMediaRefs(
  body: string,
  coverImageSrc: string | null,
  mediaFiles: ReadonlyMap<string, Buffer>,
  missing: Set<string>,
): void {
  for (const key of extractArchiveMediaKeys(body)) {
    if (!mediaFiles.has(key)) missing.add(key);
  }
  if (coverImageSrc?.startsWith("media/")) {
    const key = coverImageSrc.slice("media/".length);
    if (!mediaFiles.has(key)) missing.add(key);
  }
}

function rewriteValidatedPost(v: ValidatedPost): ValidatedPost {
  return {
    ...v,
    body: rewriteArchiveMediaLinksToPublic(v.body),
    coverImage: v.coverImage
      ? { ...v.coverImage, src: rewriteArchiveMediaSrc(v.coverImage.src) ?? v.coverImage.src }
      : null,
  };
}

function toNewPost(v: ValidatedPost): NewPost {
  return {
    title: v.title,
    slug: v.slug,
    body: v.body,
    excerpt: v.excerpt,
    coverImage: v.coverImage,
    type: v.type,
    panoramic: v.panoramic,
    showInBlog: v.showInBlog,
    featured: v.featured,
    status: v.status,
    publishDate: v.publishDate,
    tags: v.tags,
    createdAt: v.createdAt ?? undefined,
    updatedAt: v.updatedAt ?? undefined,
  };
}

function toPostUpdate(v: ValidatedPost): PostUpdate {
  return {
    title: v.title,
    slug: v.slug,
    body: v.body,
    excerpt: v.excerpt,
    coverImage: v.coverImage,
    type: v.type,
    panoramic: v.panoramic,
    showInBlog: v.showInBlog,
    featured: v.featured,
    status: v.status,
    publishDate: v.publishDate,
    tags: v.tags,
    createdAt: v.createdAt ?? undefined,
    updatedAt: v.updatedAt ?? undefined,
  };
}

function toNewPage(v: ValidatedPage): NewPage {
  return {
    title: v.title,
    slug: v.slug,
    body: v.body,
    status: v.status,
    showInNav: v.showInNav,
    createdAt: v.createdAt ?? undefined,
    updatedAt: v.updatedAt ?? undefined,
  };
}

function toPageUpdate(v: ValidatedPage): PageUpdate {
  return {
    title: v.title,
    slug: v.slug,
    body: v.body,
    status: v.status,
    showInNav: v.showInNav,
    createdAt: v.createdAt ?? undefined,
    updatedAt: v.updatedAt ?? undefined,
  };
}

async function nextAvailablePostSlug(db: Db, base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await getPostBySlug(db, candidate)) {
    candidate = `${base}-${n}`;
    n++;
  }
  return candidate;
}

async function nextAvailablePageSlug(db: Db, base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await getPageBySlug(db, candidate)) {
    candidate = `${base}-${n}`;
    n++;
  }
  return candidate;
}

function directoryKindFor(path: string): "posts" | "pages" | undefined {
  if (path.startsWith("posts/")) return "posts";
  if (path.startsWith("pages/")) return "pages";
  return undefined;
}

async function importOnePost(
  db: Db,
  mode: ImportMode,
  path: string,
  v: ValidatedPost,
): Promise<ImportItemResult> {
  const existing = await getPostBySlug(db, v.slug);

  if (mode === "skip") {
    if (existing) {
      return { path, kind: "post", slug: v.slug, outcome: "skipped", reason: "a post with this slug already exists" };
    }
    const created = await createPost(db, toNewPost(v));
    return { path, kind: "post", slug: created.slug, outcome: "created" };
  }

  if (mode === "overwrite") {
    if (existing) {
      await updatePost(db, existing.id, toPostUpdate(v));
      return { path, kind: "post", slug: v.slug, outcome: "updated" };
    }
    const created = await createPost(db, toNewPost(v));
    return { path, kind: "post", slug: created.slug, outcome: "created" };
  }

  // mode === "create": never clobber, never silently duplicate a slug.
  if (!existing) {
    const created = await createPost(db, toNewPost(v));
    return { path, kind: "post", slug: created.slug, outcome: "created" };
  }
  const finalSlug = await nextAvailablePostSlug(db, v.slug);
  const created = await createPost(db, toNewPost({ ...v, slug: finalSlug }));
  return {
    path,
    kind: "post",
    slug: created.slug,
    outcome: "created",
    reason: `slug "${v.slug}" was already taken — created as "${finalSlug}"`,
  };
}

async function importOnePage(
  db: Db,
  mode: ImportMode,
  path: string,
  v: ValidatedPage,
): Promise<ImportItemResult> {
  const existing = await getPageBySlug(db, v.slug);

  if (mode === "skip") {
    if (existing) {
      return { path, kind: "page", slug: v.slug, outcome: "skipped", reason: "a page with this slug already exists" };
    }
    const created = await createPage(db, toNewPage(v));
    return { path, kind: "page", slug: created.slug, outcome: "created" };
  }

  if (mode === "overwrite") {
    if (existing) {
      await updatePage(db, existing.id, toPageUpdate(v));
      return { path, kind: "page", slug: v.slug, outcome: "updated" };
    }
    const created = await createPage(db, toNewPage(v));
    return { path, kind: "page", slug: created.slug, outcome: "created" };
  }

  if (!existing) {
    const created = await createPage(db, toNewPage(v));
    return { path, kind: "page", slug: created.slug, outcome: "created" };
  }
  const finalSlug = await nextAvailablePageSlug(db, v.slug);
  const created = await createPage(db, toNewPage({ ...v, slug: finalSlug }));
  return {
    path,
    kind: "page",
    slug: created.slug,
    outcome: "created",
    reason: `slug "${v.slug}" was already taken — created as "${finalSlug}"`,
  };
}

/**
 * Import every markdown file + media file in `source` under the given mode.
 * Never throws for a single bad item — every failure (parse error, validation
 * error) becomes an "error" ImportItemResult and processing continues with
 * the next file (issue 002 AC: "malformed files ... do not abort the whole
 * batch"). `priorErrors` are archive/directory-level problems already found
 * while building `source` (e.g. a rejected traversal path) — merged into the
 * same report so callers only need to look in one place.
 */
export async function importSource(
  db: Db,
  storage: MediaStorage,
  source: ImportSource,
  mode: ImportMode,
  priorErrors: ReadonlyArray<SourceEntryError> = [],
): Promise<ImportReport> {
  const { importedCount: mediaImportedCount, failedKeys } = await ingestMedia(
    db,
    storage,
    source.mediaFiles,
  );

  const items: ImportItemResult[] = priorErrors.map((e) => ({
    path: e.path,
    kind: "unknown",
    slug: null,
    outcome: "error",
    reason: e.reason,
  }));

  const missingMediaRefs = new Set<string>(failedKeys);

  // Sorted for deterministic processing order (stable reports across runs;
  // also ensures "posts/" and "pages/" entries are grouped, which matters not
  // at all functionally but makes report reading easier).
  const paths = [...source.markdownFiles.keys()].sort();

  for (const path of paths) {
    const data = source.markdownFiles.get(path)!;
    const text = data.toString("utf8");
    const parsed = parseMarkdownFile(text);
    if (isFrontmatterParseError(parsed)) {
      items.push({ path, kind: "unknown", slug: null, outcome: "error", reason: parsed.error });
      continue;
    }

    const filename = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
    const hint: ClassifyHint = { directoryKind: directoryKindFor(path), filename };
    const validated = classifyAndValidate(parsed.fields, parsed.body, hint);
    if (validated.kind === "error") {
      items.push({ path, kind: "unknown", slug: null, outcome: "error", reason: validated.reason });
      continue;
    }

    if (validated.kind === "post") {
      collectMissingMediaRefs(
        validated.body,
        validated.coverImage?.src ?? null,
        source.mediaFiles,
        missingMediaRefs,
      );
      const rewritten = rewriteValidatedPost(validated);
      try {
        items.push(await importOnePost(db, mode, path, rewritten));
      } catch (e) {
        items.push({
          path,
          kind: "post",
          slug: validated.slug,
          outcome: "error",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      collectMissingMediaRefs(validated.body, null, source.mediaFiles, missingMediaRefs);
      const rewrittenBody = rewriteArchiveMediaLinksToPublic(validated.body);
      try {
        items.push(await importOnePage(db, mode, path, { ...validated, body: rewrittenBody }));
      } catch (e) {
        items.push({
          path,
          kind: "page",
          slug: validated.slug,
          outcome: "error",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  const createdCount = items.filter((i) => i.outcome === "created").length;
  const updatedCount = items.filter((i) => i.outcome === "updated").length;
  const skippedCount = items.filter((i) => i.outcome === "skipped").length;
  const errorCount = items.filter((i) => i.outcome === "error").length;

  return {
    mode,
    items,
    mediaImportedCount,
    mediaErrors: [...missingMediaRefs],
    createdCount,
    updatedCount,
    skippedCount,
    errorCount,
  };
}
