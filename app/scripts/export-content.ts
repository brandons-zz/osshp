#!/usr/bin/env bun
// CLI content export (issue 001) — headless/automated backup, no browser needed.
//
// Writes the same entries the admin console's "Export / Backup" download
// produces, straight to a directory on disk instead of a .tar.gz download —
// suited to cron/automated backups run via `docker compose exec`.
//
//   docker compose exec app ./export-content [output-dir]
//   (or: `bun run export:content -- [output-dir]`)
//
// output-dir defaults to ./export-<UTC-timestamp> under the working directory.
// Exit code is non-zero on any failure that prevented the export from
// completing (fail loud — a stale/missing media reference is recorded in
// manifest.json's mediaErrors and does not fail the run; a DB or filesystem
// error does).

import { getDb, initializeDatabase } from "@/lib/db/client";
// Import directly from ./storage (not the @/lib/media barrel): the barrel
// also re-exports ./processor, which imports the `sharp` native module at
// top level. Export never image-processes, but going through the barrel
// pulls sharp into this script's import graph anyway — and `bun build
// --compile` cannot dlopen sharp's native addon from inside the compiled
// binary's virtual filesystem, crashing every invocation on arm64/musl.
import { getMediaStorage } from "@/lib/media/storage";
import { collectExportEntries, writeExportToDirectory } from "@/lib/export";

async function main(): Promise<void> {
  const outputDir =
    process.argv[2] ?? `./export-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const db = getDb();
  await initializeDatabase(db);

  const result = await collectExportEntries(db, getMediaStorage());
  await writeExportToDirectory(result.entries, outputDir);

  process.stdout.write(
    `\nosshp content export complete → ${outputDir}\n` +
      `  • ${result.manifest.postCount} post(s)\n` +
      `  • ${result.manifest.pageCount} page(s)\n` +
      `  • ${result.manifest.mediaCount} media file(s) copied\n`,
  );
  if (result.manifest.mediaErrors.length > 0) {
    process.stdout.write(
      `  • WARNING: ${result.manifest.mediaErrors.length} referenced media ` +
        `file(s) could not be retrieved and were skipped:\n` +
        result.manifest.mediaErrors.map((k) => `      - ${k}\n`).join(""),
    );
  }
  // issue 072 defense-in-depth: a pre-existing row whose slug can't be
  // represented as a USTAR path is skipped rather than aborting the export —
  // surface it the same way a stale media reference is surfaced above.
  if (result.manifest.contentErrors.length > 0) {
    process.stdout.write(
      `  • WARNING: ${result.manifest.contentErrors.length} content item(s) ` +
        `could not be included (slug too long) and were skipped:\n` +
        result.manifest.contentErrors.map((p) => `      - ${p}\n`).join(""),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(
      `export-content failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
