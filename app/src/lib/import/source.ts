// Normalizes the different import entry points (single uploaded file, an
// uploaded tar/tar.gz archive, or a CLI-local directory) into one common
// ImportSource shape — issue 002.
//
// This is where archive-extraction safety plugs in: readArchive/parseTar
// (tar-reader.ts) already reject unsafe paths and oversized/non-regular-file
// entries; this module classifies each SAFE entry into markdownFiles vs
// mediaFiles by its archive-relative path and reports anything it can't
// classify, again without aborting the whole batch.

import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { readArchive, isTarReadError, type TarReadEntry } from "./tar-reader";
import type { ImportSource } from "./types";

export interface SourceEntryError {
  path: string;
  reason: string;
}

export interface BuiltSource {
  source: ImportSource;
  /** Archive/directory-level problems (bad paths, unsupported entries, oversized
   *  files) — surfaced as "error" items in the final ImportReport, not thrown. */
  entryErrors: SourceEntryError[];
}

function emptySource(): ImportSource {
  return { markdownFiles: new Map(), mediaFiles: new Map() };
}

/** Classify one already-safe archive-relative path into markdown/media/ignored. */
function classifyEntry(
  path: string,
  data: Buffer,
  source: ImportSource,
  entryErrors: SourceEntryError[],
): void {
  if (path === "manifest.json") return; // informational only, not imported
  if ((path.startsWith("posts/") || path.startsWith("pages/")) && path.endsWith(".md")) {
    source.markdownFiles.set(path, data);
    return;
  }
  if (path.startsWith("media/")) {
    const key = path.slice("media/".length);
    if (key === "") {
      entryErrors.push({ path, reason: "media entry has an empty key" });
      return;
    }
    source.mediaFiles.set(key, data);
    return;
  }
  // Anything outside posts/, pages/, media/, manifest.json is not part of the
  // export shape — reported, not silently dropped, but does not abort the batch.
  entryErrors.push({ path, reason: "not a recognized export-shape path (expected posts/, pages/, or media/)" });
}

/** Build a source from a single uploaded/loose Markdown file (no directory context). */
export function sourceFromSingleMarkdown(filename: string, data: Buffer): BuiltSource {
  const source = emptySource();
  // No real archive path context — key it by the bare filename so downstream
  // reporting still has something meaningful to show the operator.
  source.markdownFiles.set(filename, data);
  return { source, entryErrors: [] };
}

/** Build a source from an uploaded/on-disk tar or tar.gz archive's bytes. */
export async function sourceFromTar(archiveBytes: Buffer): Promise<BuiltSource> {
  const source = emptySource();
  const entryErrors: SourceEntryError[] = [];
  const entries: TarReadEntry[] = await readArchive(archiveBytes);
  for (const entry of entries) {
    if (isTarReadError(entry)) {
      entryErrors.push({ path: entry.path, reason: entry.error });
      continue;
    }
    classifyEntry(entry.path, entry.data, source, entryErrors);
  }
  return { source, entryErrors };
}

const MAX_DIR_ENTRY_BYTES = 100 * 1024 * 1024; // matches tar-reader's MAX_ENTRY_BYTES

/**
 * Build a source from a directory on disk matching the export shape
 * (posts/, pages/, media/) — the CLI-only bulk path (issue 002 AC: "a folder
 * ... of Markdown files"). Trusted-operator-supplied root path, but file
 * CONTENTS are still treated as untrusted (same validation as the archive
 * path) since the directory may have been downloaded from elsewhere.
 *
 * Symlinks are skipped (not followed) — defense against a symlink planted in
 * the source directory pointing outside it.
 */
export async function sourceFromDirectory(root: string): Promise<BuiltSource> {
  const source = emptySource();
  const entryErrors: SourceEntryError[] = [];

  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      entryErrors.push({
        path: relative(root, dir) || ".",
        reason: `could not read directory: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      let stat;
      try {
        stat = await lstat(full);
      } catch (e) {
        entryErrors.push({ path: rel, reason: `could not stat: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      if (stat.isSymbolicLink()) {
        entryErrors.push({ path: rel, reason: "symlink skipped (not followed)" });
        continue;
      }
      if (stat.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!stat.isFile()) {
        entryErrors.push({ path: rel, reason: "not a regular file" });
        continue;
      }
      if (stat.size > MAX_DIR_ENTRY_BYTES) {
        entryErrors.push({ path: rel, reason: `entry exceeds ${MAX_DIR_ENTRY_BYTES} bytes` });
        continue;
      }
      const data = await readFile(full);
      classifyEntry(rel, data, source, entryErrors);
    }
  }

  await walk(root);
  return { source, entryErrors };
}
