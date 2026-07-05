// Content export orchestration (issue 001).
//
// SCOPE: posts (articles + photo-posts), pages, and the media they reference.
// Deliberately does NOT export settings, admin_user, or any secret — this is
// an admin-triggered egress boundary (drafts/unpublished content can leave
// the instance), and the settings/secret surface is out of scope by omission,
// not by a blocklist that could drift. See docs/decisions/0002-content-export-format.md.
//
// ALL content states are included (draft, published, scheduled) — this is a
// backup/lock-in-prevention tool for the operator's own admin console, not a
// public-facing read, so the theme's published-only boundary (§3.3) does not
// apply here.
//
// Two consumers share collectExportEntries(): the admin download route builds
// an in-memory tar.gz (buildExportArchive), and the CLI writes the same
// entries straight to disk (writeExportToDirectory) — one source of truth for
// "what's in an export", two renderings of it.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { listPages, listPosts, getMediaByKey } from "@/lib/content";
import type { Page, Post } from "@/lib/content/types";
import type { MediaStorage } from "@/lib/media";
import { buildTar, pathFitsUstar } from "./tar";
import {
  pageFrontmatterFields,
  postFrontmatterFields,
  serializeMarkdownFile,
} from "./frontmatter";
import { extractMediaKeys, rewriteMediaLinks } from "./media-refs";
import type { Db } from "@/lib/db/types";

/** One media object's attribution metadata (issue 077), keyed by its
 *  archive-relative media key in the exported manifest. */
export interface ExportedMediaAttribution {
  sourceUrl: string | null;
  attribution: string | null;
  license: string | null;
}

export interface ExportEntry {
  /** Archive-relative path, e.g. "posts/hello-world.md" or "media/<key>". */
  path: string;
  data: Buffer;
}

export interface ExportManifest {
  exportedAt: string;
  postCount: number;
  pageCount: number;
  mediaCount: number;
  /** Storage keys referenced by content but not retrievable from object storage. */
  mediaErrors: string[];
  /**
   * Archive-relative paths that could not be represented in a USTAR header
   * (issue 072) and were therefore excluded from the archive rather than
   * aborting the whole export. The create/update routes bound title/slug
   * length so this should never populate for content created going forward;
   * this is defense-in-depth for any row that predates that bound.
   */
  contentErrors: string[];
  /**
   * Attribution metadata (issue 077) for every exported media object that has
   * ANY of `sourceUrl`/`attribution`/`license` set, keyed by the SAME
   * archive-relative media key used for `media/<key>` entries. Absent for an
   * ordinary upload with none of these fields set — this keeps the manifest
   * free of noise for the common case. Optional field: an archive exported
   * before this amendment simply lacks it (see ADR 0003 §"Media handling").
   */
  mediaAttribution?: Record<string, ExportedMediaAttribution>;
}

export interface ExportResult {
  /** Every file in the archive, including the trailing manifest.json entry. */
  entries: ExportEntry[];
  manifest: ExportManifest;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function postEntry(post: Post): { entry: ExportEntry; mediaKeys: string[] } {
  const body = rewriteMediaLinks(post.body);
  const mediaKeys = new Set(extractMediaKeys(post.body));
  const coverImage = post.coverImage
    ? { ...post.coverImage, src: rewriteMediaLinks(post.coverImage.src) }
    : null;
  if (post.coverImage) {
    for (const key of extractMediaKeys(post.coverImage.src)) mediaKeys.add(key);
  }
  // Gallery membership (issue 050/047): every gallery image is a real media
  // reference that must land in the archive's media/ folder too, exactly like
  // coverImage/body above — otherwise a re-import restores empty galleries.
  const gallery = post.gallery.map((g) => {
    for (const key of extractMediaKeys(g.src)) mediaKeys.add(key);
    return { ...g, src: rewriteMediaLinks(g.src) };
  });
  // The chosen cover is identified by matching post.coverMediaId against the
  // (pre-rewrite) gallery entries, then re-expressed as a portable
  // archive-relative media key — see postFrontmatterFields's doc comment.
  const coverGalleryEntry = post.coverMediaId
    ? post.gallery.find((g) => g.mediaId === post.coverMediaId)
    : undefined;
  const galleryCoverKey = coverGalleryEntry
    ? rewriteMediaLinks(coverGalleryEntry.src)
    : null;
  const fields = postFrontmatterFields({ ...post, coverImage, gallery }, galleryCoverKey);
  const data = Buffer.from(serializeMarkdownFile(fields, body), "utf8");
  return { entry: { path: `posts/${post.slug}.md`, data }, mediaKeys: [...mediaKeys] };
}

function pageEntry(page: Page): { entry: ExportEntry; mediaKeys: string[] } {
  const body = rewriteMediaLinks(page.body);
  const mediaKeys = extractMediaKeys(page.body);
  const fields = pageFrontmatterFields(page);
  const data = Buffer.from(serializeMarkdownFile(fields, body), "utf8");
  return { entry: { path: `pages/${page.slug}.md`, data }, mediaKeys };
}

/**
 * Read every post + page (all statuses) and every media object they
 * reference, and assemble the flat entry list an archive/directory is built
 * from. Pure orchestration — no archive format or filesystem I/O here.
 */
export async function collectExportEntries(
  db: Db,
  storage: MediaStorage,
): Promise<ExportResult> {
  const posts = await listPosts(db);
  const pages = await listPages(db);

  const entries: ExportEntry[] = [];
  const allMediaKeys = new Set<string>();
  // issue 072 defense-in-depth: the create/update routes bound title/slug
  // length so this should never trigger for new content, but a row that
  // predates that bound (or any future path-construction change) must not be
  // allowed to throw buildHeader() and abort the ENTIRE archive — degrade the
  // one unrepresentable item into a manifest entry instead, same shape as
  // mediaErrors below.
  const contentErrors: string[] = [];

  for (const post of posts) {
    const { entry, mediaKeys } = postEntry(post);
    if (!pathFitsUstar(entry.path)) {
      contentErrors.push(entry.path);
      continue;
    }
    entries.push(entry);
    for (const key of mediaKeys) allMediaKeys.add(key);
  }
  for (const page of pages) {
    const { entry, mediaKeys } = pageEntry(page);
    if (!pathFitsUstar(entry.path)) {
      contentErrors.push(entry.path);
      continue;
    }
    entries.push(entry);
    for (const key of mediaKeys) allMediaKeys.add(key);
  }

  const mediaErrors: string[] = [];
  // Issue 077: attribution is a media-row property, not a post/page field, so
  // it's collected once per distinct referenced key here — alongside the same
  // loop that already copies each object's bytes into the archive — rather
  // than duplicated into every post/page frontmatter that happens to embed it.
  const mediaAttribution: Record<string, ExportedMediaAttribution> = {};
  for (const key of allMediaKeys) {
    try {
      const obj = await storage.get(key);
      const data = await streamToBuffer(obj.stream);
      entries.push({ path: `media/${key}`, data });
    } catch {
      // A stale/missing reference must not silently make the archive
      // incomplete — record it in the manifest (fail loud) rather than
      // aborting the whole export over one broken image.
      mediaErrors.push(key);
      continue;
    }
    const media = await getMediaByKey(db, key);
    if (media && (media.sourceUrl || media.attribution || media.license)) {
      mediaAttribution[key] = {
        sourceUrl: media.sourceUrl,
        attribution: media.attribution,
        license: media.license,
      };
    }
  }

  const manifest: ExportManifest = {
    exportedAt: new Date().toISOString(),
    postCount: posts.length,
    pageCount: pages.length,
    mediaCount: allMediaKeys.size - mediaErrors.length,
    mediaErrors,
    contentErrors,
    ...(Object.keys(mediaAttribution).length > 0 ? { mediaAttribution } : {}),
  };
  entries.push({
    path: "manifest.json",
    data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
  });

  return { entries, manifest };
}

type BunGzip = { gzipSync(input: Uint8Array): Uint8Array };

function bunGzip(): BunGzip {
  const b = (globalThis as { Bun?: BunGzip }).Bun;
  if (!b?.gzipSync) {
    throw new Error(
      "Building a downloadable export archive requires the Bun runtime " +
        "(Bun.gzipSync). The osshp production artifact runs `bun server.js`; " +
        "ensure the server runs under Bun.",
    );
  }
  return b;
}

/** Build a single gzip-compressed tar (.tar.gz) archive from export entries. */
export function buildExportArchive(entries: ExportEntry[]): Buffer {
  const tar = buildTar(entries);
  return Buffer.from(bunGzip().gzipSync(tar));
}

/**
 * Write export entries directly to a directory on disk (the CLI path) —
 * `posts/`, `pages/`, `media/<key...>`, and `manifest.json` under `dir`.
 * Creates parent directories as needed.
 */
export async function writeExportToDirectory(
  entries: ExportEntry[],
  dir: string,
): Promise<void> {
  for (const entry of entries) {
    const fullPath = join(dir, entry.path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, entry.data);
  }
}
