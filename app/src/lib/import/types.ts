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
  /** Present for "skipped" and "error" outcomes. */
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

/** The normalized input to importSource() — every entry point (single file,
 *  directory walk, tar archive) is reduced to this shape before orchestration. */
export interface ImportSource {
  /** Archive-relative path (e.g. "posts/hello.md") -> raw file bytes. */
  markdownFiles: Map<string, Buffer>;
  /** Archive-relative media key (e.g. "abc/800.jpg") -> raw bytes. */
  mediaFiles: Map<string, Buffer>;
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
