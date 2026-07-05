// Public types for the content import pipeline (issue 002).

import type { ImageRef } from "@/lib/content/types";

/**
 * Re-import behavior, chosen by the importer at import time (issue 002 AC —
 * not a fixed policy). Selectable via the admin console form and the CLI
 * `--mode` flag; every mode is exercised by tests.
 *
 *  - "skip":      an existing slug is left untouched; the item is reported
 *                 skipped with a reason. No silent clobber.
 *  - "overwrite": an existing slug's fields (including original createdAt/
 *                 updatedAt, for a lossless restore) are replaced in place.
 *                 Absent -> created instead.
 *  - "create":    always creates a new entry. A colliding slug is disambiguated
 *                 (`-2`, `-3`, ...) rather than silently duplicating an
 *                 existing slug value or clobbering the existing row.
 */
export type ImportMode = "skip" | "overwrite" | "create";

export const IMPORT_MODES: readonly ImportMode[] = ["skip", "overwrite", "create"];

export function isImportMode(value: unknown): value is ImportMode {
  return typeof value === "string" && (IMPORT_MODES as readonly string[]).includes(value);
}

export type ImportOutcome = "created" | "updated" | "skipped" | "error";

export interface ImportItemResult {
  /** Source path/filename for operator traceability (e.g. "posts/hello.md"). */
  path: string;
  kind: "post" | "page" | "unknown";
  /** The slug actually used — may differ from the source on a "create" collision. */
  slug: string | null;
  outcome: ImportOutcome;
  /** Present for "skipped"/"error" outcomes, and on "created"/"updated" when
   *  something noteworthy happened (a slug collision was disambiguated, or a
   *  published missing-alt gallery was demoted to draft — issue 066). */
  reason?: string;
}

export interface ImportReport {
  mode: ImportMode;
  items: ImportItemResult[];
  mediaImportedCount: number;
  /** Referenced media keys the source did not include bytes for. Mirrors the
   *  export manifest's mediaErrors shape — recorded, not fatal. */
  mediaErrors: string[];
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
}

/** One media object's attribution metadata (issue 077), as recorded in the
 *  export manifest — see lib/export/exporter.ts's ExportedMediaAttribution
 *  (the identical shape; duplicated here rather than imported so the import
 *  module never depends on the export module). */
export interface ImportedMediaAttribution {
  sourceUrl: string | null;
  attribution: string | null;
  license: string | null;
}

/** The normalized input to importSource() — every entry point (single file,
 *  directory walk, tar archive) is reduced to this shape before orchestration. */
export interface ImportSource {
  /** Archive-relative path (e.g. "posts/hello.md") -> raw file bytes. */
  markdownFiles: Map<string, Buffer>;
  /** Archive-relative media key (e.g. "abc/800.jpg") -> raw bytes. */
  mediaFiles: Map<string, Buffer>;
  /**
   * Attribution metadata (issue 077) parsed from manifest.json's optional
   * `mediaAttribution` field, keyed by the same archive-relative media key as
   * `mediaFiles`. Empty when the source has no manifest.json, an unparseable
   * one, or one predating this amendment (ADR 0003) — restoring attribution
   * is always best-effort and never blocks or fails an import.
   */
  mediaAttribution: Map<string, ImportedMediaAttribution>;
}

/**
 * One parsed-but-unresolved gallery entry (issue 050). `key` is the archive-
 * relative media storage key (the "media/" prefix already stripped) — it is
 * resolved to a live `mediaId` at import time (see importer.ts), once media
 * ingestion has run, because a DB id from the SOURCE instance means nothing
 * on the TARGET instance.
 */
export interface ValidatedGalleryEntry {
  key: string;
  alt: string;
  caption: string;
}

/** A validated, ready-to-persist post payload derived from parsed frontmatter. */
export interface ValidatedPost {
  kind: "post";
  title: string;
  slug: string;
  type: "article" | "photo-post";
  status: "draft" | "published" | "scheduled";
  tags: Array<{ name: string; slug: string }>;
  publishDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  excerpt: string;
  coverImage: ImageRef | null;
  panoramic: boolean;
  showInBlog: boolean;
  featured: boolean;
  /** Issue 050/047: gallery membership, parsed but not yet resolved to media ids. */
  isGallery: boolean;
  /** Archive-relative key of the explicitly-chosen cover, or null (defaults
   *  to the first gallery image at write time — see Post.coverImage()). */
  galleryCoverKey: string | null;
  gallery: ValidatedGalleryEntry[];
  body: string;
}

/** A validated, ready-to-persist page payload derived from parsed frontmatter. */
export interface ValidatedPage {
  kind: "page";
  title: string;
  slug: string;
  status: "draft" | "published" | "scheduled";
  showInNav: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  body: string;
}

export type ValidationResult =
  | ValidatedPost
  | ValidatedPage
  | { kind: "error"; reason: string };
