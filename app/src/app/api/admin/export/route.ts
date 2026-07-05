// GET /api/admin/export — download a self-contained .tar.gz archive of all
// content (issue 001: "Export / Backup" admin console action).
//
// Admin surface: the default-deny middleware requires a signed session to
// reach here; this handler ALSO authoritatively validates it (revocation/
// expiry) — same pattern as every other /api/admin/* route. GET is a safe
// method (no state change), so no guardMutation/CSRF wrapper is needed — a
// forged cross-site GET can only trigger a download to the attacker's own
// browser context, which same-origin policy already prevents from being read.
//
// Includes ALL content states (draft/published/scheduled) — this is the
// operator's own backup of their own content, not a public read, so the
// theme's published-only boundary does not apply. Settings/secrets are never
// part of this archive (see lib/export/exporter.ts scope note).

import { getDb } from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/platform";
import { getMediaStorage } from "@/lib/media";
import { buildExportArchive, collectExportEntries } from "@/lib/export";

export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const result = await collectExportEntries(db, getMediaStorage());
  const archive = buildExportArchive(result.entries);

  const filename = `osshp-export-${result.manifest.exportedAt.replace(/[:.]/g, "-")}.tar.gz`;

  return new Response(new Uint8Array(archive), {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-length": String(archive.length),
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
