// POST /api/admin/import — the "Import content" admin console action (issue 002).
//
// Admin surface: not on the public allowlist, so the default-deny middleware
// requires a signed session to reach here; this handler ALSO authoritatively
// validates it (revocation/expiry) — same pattern as every other /api/admin/*
// mutating route. guardMutation-wrapped (CSRF, no-store).
//
// Accepts a multipart form: `file` (a single Markdown file, a .tar, or a
// .tar.gz — auto-detected) and `mode` (skip|overwrite|create — the re-import
// behavior the importer chooses at import time, issue 002 AC). Responds with
// the full ImportReport (created/skipped-with-reason/errors) as JSON.
//
// This is the sharpest new trust boundary the import feature adds — the
// uploaded bytes are untrusted. The route itself only bounds the raw upload
// size; path-traversal/zip-slip, oversized-entry, and non-regular-file
// defenses live in lib/import/tar-reader.ts (see that module's doc comment).

import { getDb } from "@/lib/db/client";
import { guardMutation } from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";
import { getMediaStorage } from "@/lib/media";
import { importSource, isImportMode, sourceFromSingleMarkdown, sourceFromTar } from "@/lib/import";

// A generous ceiling on the raw upload — a whole-instance archive can carry
// years of media. Finer-grained caps (per-entry, total-decompressed-bytes,
// entry count) are enforced inside lib/import/tar-reader.ts regardless of
// this outer bound.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

function looksLikeTar(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const modeRaw = form.get("mode");
  const mode = typeof modeRaw === "string" ? modeRaw : "skip";
  if (!isImportMode(mode)) {
    return Response.json(
      { error: `invalid mode: ${JSON.stringify(modeRaw)} (expected skip, overwrite, or create)` },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "missing file field" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "file too large" }, { status: 413 });
  }
  if (file.size === 0) {
    return Response.json({ error: "empty file" }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const { source, entryErrors } = looksLikeTar(file.name)
    ? await sourceFromTar(bytes)
    : sourceFromSingleMarkdown(file.name || "upload.md", bytes);

  const report = await importSource(db, getMediaStorage(), source, mode, entryErrors);
  return Response.json(report, { status: 200 });
});
