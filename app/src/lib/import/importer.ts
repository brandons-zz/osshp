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
  updateMediaAttribution,
  getPageBySlug,
  getPostBySlug,
  updatePage,
  updatePost,
} from "@/lib/content";
import type {
  GalleryInput,
  NewPage,
  NewPost,
  PageUpdate,
  PostUpdate,
} from "@/lib/content/types";
import type { Db } from "@/lib/db/types";
import type { MediaStorage } from "@/lib/media";
import { isFrontmatterParseError, parseMarkdownFile } from "./frontmatter";
import {
  extractArchiveMediaKeys,
  rewriteArchiveMediaLinksToPublic,
  rewriteArchiveMediaSrc,
} from "./media-refs";
// The publish-time gallery alt gate + the gallery-size ceiling (issue 066):
// the SAME pure check and the SAME cap constant the photos routes enforce
// (WCAG 1.1.1 — "publishing a missing-alt gallery is impossible from ANY
// admin route", issue 051 — and POST /api/admin/import IS an admin route;
// likewise the import path must not be able to construct a gallery the route
// layer forbids). Imported from the routes' shared module rather than
// re-implemented, so both invariants have exactly one definition that cannot
// drift between writers.
import {
  galleryPublishAltError,
  MAX_GALLERY_SIZE,
} from "@/app/api/admin/photos/posts/_gallery";
import { classifyAndValidate, type ClassifyHint } from "./schema";
import { nextAvailableSlug } from "./slug";
import { isSafeArchivePath } from "./tar-reader";
import type {
  ImportedMediaAttribution,
  ImportItemResult,
  ImportMode,
  ImportReport,
  ImportSource,
  ValidatedGalleryEntry,
  ValidatedPage,
  ValidatedPost,
} from "./types";
import type { SourceEntryError } from "./source";
// Module-enablement gate (issue 069, the same completeness class as issue 028
// NB-A): every module-owned admin content-API route calls
// requireModuleEnabled right after session validation, but the import path
// writes posts/pages directly through the content stores with no route-level
// gate in front of it. Import is a fourth writer (alongside the blog/pages/
// photos admin routes) for the SAME rows those routes own, so it must honor
// the same "a disabled module contributes nothing" invariant (module-contract
// §3.1 rule 4) — checked per item here (not once for the whole batch) so a
// disabled module can't abort import of content belonging to modules that
// ARE enabled, mirroring the existing "one bad item doesn't abort the batch"
// handling of malformed files.
import { getEnabledModuleIds, isEnabled } from "@/lib/module";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { PAGES_MODULE_ID } from "@/modules/pages/manifest";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";

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
  mediaAttribution: ReadonlyMap<string, ImportedMediaAttribution>,
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
      // Issue 077: restore attribution recorded in manifest.json, when
      // present, for both a freshly-created row AND a re-import of an
      // already-ingested one (e.g. overwrite mode re-running the same
      // archive) — best-effort, never blocks the batch.
      const attribution = mediaAttribution.get(key);
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
          ...(attribution
            ? {
                sourceUrl: attribution.sourceUrl,
                attribution: attribution.attribution,
                license: attribution.license,
              }
            : {}),
        });
      } else if (attribution) {
        await updateMediaAttribution(db, existing.id, {
          sourceUrl: attribution.sourceUrl,
          attribution: attribution.attribution,
          license: attribution.license,
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

/** One resolved gallery entry: the write-ready input plus the archive media
 *  key it resolved from (kept so report messages can NAME an image — a
 *  mediaId means nothing to the operator reading the report). */
interface ResolvedGalleryEntry {
  key: string;
  input: GalleryInput;
}

/**
 * Resolve a parsed-but-unresolved gallery (issue 050) into live `mediaId`s.
 * Must run AFTER ingestMedia() so a key the source provided bytes for already
 * has a media row. An entry whose key never resolves (source omitted the
 * bytes, or the file failed to ingest) is dropped — not fatal, mirroring
 * collectMissingMediaRefs's "record it, keep going" handling of a broken
 * body/coverImage reference — and its key is added to `missingMediaRefs` so
 * it surfaces in the same ImportReport.mediaErrors list. Array order (which
 * becomes post_media.position) is preserved for every entry that DOES
 * resolve.
 */
async function resolveGalleryInputs(
  db: Db,
  gallery: ReadonlyArray<ValidatedGalleryEntry>,
  missingMediaRefs: Set<string>,
): Promise<ResolvedGalleryEntry[]> {
  const out: ResolvedGalleryEntry[] = [];
  for (const g of gallery) {
    const media = await getMediaByKey(db, g.key);
    if (!media) {
      missingMediaRefs.add(g.key);
      continue;
    }
    out.push({ key: g.key, input: { mediaId: media.id, caption: g.caption, alt: g.alt } });
  }
  return out;
}

/**
 * The import-path enforcement of the publish-time gallery alt gate
 * (issue 066). The archive's per-entry alt is the EFFECTIVE alt here: import
 * always writes it through to the media row (resolveGalleryInputs always sets
 * `alt`), so unlike the PATCH route there is no stored-alt fallback to
 * consult — what's in the archive is what the published gallery would carry.
 *
 * On a violation the post is demoted to DRAFT rather than failed (import
 * stays lenient — content is never lost — and nothing missing-alt becomes
 * publicly visible; the operator finishes the alts in the console and
 * publishes from there). Returns the demoted post + an operator-facing
 * reason naming the alt-less images by their archive media key, or null when
 * no demotion is needed. Judged via the same galleryPublishAltError the
 * photos routes enforce, which also covers `scheduled` (a scheduled gallery
 * auto-reveals when its date passes — publicly visible all the same) and a
 * published gallery whose entries all failed to resolve (empty gallery).
 */
function demoteMissingAltGallery(
  v: ValidatedPost,
  resolved: ReadonlyArray<ResolvedGalleryEntry>,
): { v: ValidatedPost; reason: string } | null {
  if (!v.isGallery) return null;
  const altError = galleryPublishAltError(
    v.status,
    true,
    resolved.map((r) => r.input),
  );
  if (altError === null) return null;
  const missingKeys = resolved
    .filter((r) => (r.input.alt ?? "").trim() === "")
    .map((r) => r.key);
  const naming =
    missingKeys.length > 0 ? ` Images missing alt: ${missingKeys.join(", ")}.` : "";
  return {
    v: { ...v, status: "draft" },
    reason: `imported as draft instead of ${v.status} — ${altError}${naming}`,
  };
}

/**
 * Resolve the gallery's explicit cover choice (a portable archive-relative
 * media key) to a live media id. `null` in either direction means "no
 * explicit choice" — Post.coverImage() already defaults to the first gallery
 * image when cover_media_id is null, so an unresolved key falls back to that
 * same default rather than failing the import.
 */
async function resolveGalleryCoverMediaId(
  db: Db,
  key: string | null,
  missingMediaRefs: Set<string>,
): Promise<string | null> {
  if (key === null) return null;
  const media = await getMediaByKey(db, key);
  if (!media) {
    missingMediaRefs.add(key);
    return null;
  }
  return media.id;
}

function toNewPost(v: ValidatedPost, gallery: GalleryInput[], coverMediaId: string | null): NewPost {
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
    isGallery: v.isGallery,
    coverMediaId,
    gallery,
    status: v.status,
    publishDate: v.publishDate,
    tags: v.tags,
    createdAt: v.createdAt ?? undefined,
    updatedAt: v.updatedAt ?? undefined,
  };
}

function toPostUpdate(v: ValidatedPost, gallery: GalleryInput[], coverMediaId: string | null): PostUpdate {
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
    isGallery: v.isGallery,
    coverMediaId,
    gallery,
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
  gallery: GalleryInput[],
  coverMediaId: string | null,
): Promise<ImportItemResult> {
  const existing = await getPostBySlug(db, v.slug);

  if (mode === "skip") {
    if (existing) {
      return { path, kind: "post", slug: v.slug, outcome: "skipped", reason: "a post with this slug already exists" };
    }
    const created = await createPost(db, toNewPost(v, gallery, coverMediaId));
    return { path, kind: "post", slug: created.slug, outcome: "created" };
  }

  if (mode === "overwrite") {
    if (existing) {
      await updatePost(db, existing.id, toPostUpdate(v, gallery, coverMediaId));
      return { path, kind: "post", slug: v.slug, outcome: "updated" };
    }
    const created = await createPost(db, toNewPost(v, gallery, coverMediaId));
    return { path, kind: "post", slug: created.slug, outcome: "created" };
  }

  // mode === "create": never clobber, never silently duplicate a slug.
  if (!existing) {
    const created = await createPost(db, toNewPost(v, gallery, coverMediaId));
    return { path, kind: "post", slug: created.slug, outcome: "created" };
  }
  const finalSlug = await nextAvailablePostSlug(db, v.slug);
  const created = await createPost(db, toNewPost({ ...v, slug: finalSlug }, gallery, coverMediaId));
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
    source.mediaAttribution,
  );

  const items: ImportItemResult[] = priorErrors.map((e) => ({
    path: e.path,
    kind: "unknown",
    slug: null,
    outcome: "error",
    reason: e.reason,
  }));

  const missingMediaRefs = new Set<string>(failedKeys);

  // Issue 069: resolved once per batch (module state doesn't change mid-run)
  // and consulted per item below — a disabled module's owned content type
  // must not be created/updated by import, the same as its own admin route.
  const enabledModuleIds = await getEnabledModuleIds(db);

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
      // Issue 069: the resolved type's owning module gates this item exactly
      // as it gates the blog/photos admin routes — reported as a per-item
      // "error" outcome (not a batch abort) so other items still import.
      const postModuleId =
        validated.type === "photo-post" ? PHOTOS_MODULE_ID : BLOG_MODULE_ID;
      const postModuleName = validated.type === "photo-post" ? "Photos" : "Blog";
      if (!isEnabled(enabledModuleIds, postModuleId)) {
        items.push({
          path,
          kind: "post",
          slug: validated.slug,
          outcome: "error",
          reason: `the ${postModuleName} module is disabled`,
        });
        continue;
      }
      collectMissingMediaRefs(
        validated.body,
        validated.coverImage?.src ?? null,
        source.mediaFiles,
        missingMediaRefs,
      );
      let rewritten = rewriteValidatedPost(validated);
      let resolved = await resolveGalleryInputs(db, validated.gallery, missingMediaRefs);
      const galleryNotes: string[] = [];
      // Issue 066: the admin routes' hard gallery-size ceiling applies on
      // import too — the import path must not construct a gallery the route
      // layer forbids. Excess entries are dropped (order-preserving), never a
      // silent truncate: the report entry says how many.
      if (resolved.length > MAX_GALLERY_SIZE) {
        const dropped = resolved.length - MAX_GALLERY_SIZE;
        resolved = resolved.slice(0, MAX_GALLERY_SIZE);
        galleryNotes.push(
          `gallery capped at the ${MAX_GALLERY_SIZE}-image limit — ` +
            `${dropped} excess image${dropped === 1 ? "" : "s"} dropped`,
        );
      }
      const gallery = resolved.map((r) => r.input);
      const coverMediaId = await resolveGalleryCoverMediaId(
        db,
        validated.galleryCoverKey,
        missingMediaRefs,
      );
      // Issue 066: a published/scheduled gallery with missing effective alts —
      // or with no images at all (none resolvable, or authored empty) — must
      // never go publicly visible via import. Judged on the capped, resolved
      // set (what will actually be written); demote to draft and say so in
      // the report, per item.
      const demotion = demoteMissingAltGallery(rewritten, resolved);
      if (demotion) {
        rewritten = demotion.v;
        galleryNotes.push(demotion.reason);
      }
      try {
        const result = await importOnePost(db, mode, path, rewritten, gallery, coverMediaId);
        if (
          galleryNotes.length > 0 &&
          (result.outcome === "created" || result.outcome === "updated")
        ) {
          const note = galleryNotes.join("; ");
          result.reason = result.reason ? `${result.reason}; ${note}` : note;
        }
        items.push(result);
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
      // Issue 069: same per-item module gate for pages (Pages module).
      if (!isEnabled(enabledModuleIds, PAGES_MODULE_ID)) {
        items.push({
          path,
          kind: "page",
          slug: validated.slug,
          outcome: "error",
          reason: "the Pages module is disabled",
        });
        continue;
      }
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
