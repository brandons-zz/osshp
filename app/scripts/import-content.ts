#!/usr/bin/env bun
// CLI content import (issue 002) — headless/automated bulk import, no browser
// needed. Reads the same posts/, pages/, media/ archive shape the admin
// console's "Export / Backup" download (and this CLI's own `export-content`
// counterpart) produce.
//
//   docker compose exec app ./import-content <path> [--mode=skip|overwrite|create]
//   (or: `bun run import:content -- <path> [--mode=...]`)
//
// <path> may be:
//   - a single .md file (one entry)
//   - a .tar or .tar.gz archive matching the export archive layout
//   - a directory on disk matching the export archive layout (posts/, pages/,
//     media/) — the folder-import case (issue 002 AC)
//
// --mode defaults to "skip" (never clobbers, never silently duplicates).
//
// Exit code is non-zero only for a failure that prevented the run from
// completing (bad arguments, unreadable path, DB error). A malformed
// individual file inside the source is reported in the printed report and
// does NOT fail the run — same "fail loud on real failures, keep going on
// per-item problems" split as export-content.ts.

import { stat } from "node:fs/promises";
import { getDb, initializeDatabase } from "@/lib/db/client";
// Import directly from ./storage (not the @/lib/media barrel): the barrel
// also re-exports ./processor, which imports the `sharp` native module at
// top level. Import never image-processes bulk media (bytes are copied
// verbatim into storage — see lib/import/importer.ts), but going through the
// barrel pulls sharp into this script's import graph anyway — and `bun build
// --compile` cannot dlopen sharp's native addon from inside the compiled
// binary's virtual filesystem, crashing every invocation on arm64/musl (same
// bug fixed in export-content.ts — see that commit's message for the
// verified fail-on-old/pass-on-new repro).
import { getMediaStorage } from "@/lib/media/storage";
import {
  importSource,
  isImportMode,
  sourceFromDirectory,
  sourceFromSingleMarkdown,
  sourceFromTar,
  type ImportMode,
} from "@/lib/import";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

function parseArgs(argv: string[]): { path: string; mode: ImportMode } {
  const positional: string[] = [];
  let mode: ImportMode = "skip";
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (!isImportMode(value)) {
        throw new Error(`invalid --mode value: ${JSON.stringify(value)} (expected skip, overwrite, or create)`);
      }
      mode = value;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length === 0) {
    throw new Error("usage: import-content <path> [--mode=skip|overwrite|create]");
  }
  return { path: positional[0], mode };
}

function looksLikeTar(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

async function main(): Promise<void> {
  const { path, mode } = parseArgs(process.argv.slice(2));

  const st = await stat(path);

  const db = getDb();
  await initializeDatabase(db);
  const storage = getMediaStorage();

  const built = st.isDirectory()
    ? await sourceFromDirectory(path)
    : looksLikeTar(path)
      ? await sourceFromTar(await readFile(path))
      : sourceFromSingleMarkdown(basename(path), await readFile(path));

  const report = await importSource(db, storage, built.source, mode, built.entryErrors);

  process.stdout.write(
    `\nosshp content import complete (mode: ${report.mode})\n` +
      `  • ${report.createdCount} created\n` +
      `  • ${report.updatedCount} updated\n` +
      `  • ${report.skippedCount} skipped\n` +
      `  • ${report.errorCount} error(s)\n` +
      `  • ${report.mediaImportedCount} media file(s) imported\n`,
  );

  if (report.errorCount > 0) {
    process.stdout.write(`\nErrors:\n`);
    for (const item of report.items) {
      if (item.outcome === "error") {
        process.stdout.write(`  - ${item.path}: ${item.reason}\n`);
      }
    }
  }
  if (report.skippedCount > 0) {
    process.stdout.write(`\nSkipped:\n`);
    for (const item of report.items) {
      if (item.outcome === "skipped") {
        process.stdout.write(`  - ${item.path} (${item.slug}): ${item.reason}\n`);
      }
    }
  }
  if (report.mediaErrors.length > 0) {
    process.stdout.write(
      `\nWARNING: ${report.mediaErrors.length} referenced media file(s) were not ` +
        `found in the source and were left unresolved:\n` +
        report.mediaErrors.map((k) => `  - ${k}\n`).join(""),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(
      `import-content failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
