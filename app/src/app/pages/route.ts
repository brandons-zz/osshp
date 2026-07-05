// GET /pages — the published-pages index (V-010).
// Lists all published pages as a clean, on-identity listing rendered through
// the active theme. Only PUBLISHED pages appear (the theme materialization
// boundary, §3.3); draft pages are never listed. Inert when the Pages module
// is disabled.

import { getDb } from "@/lib/db/client";
import { isModuleEnabled } from "@/lib/platform";
import { renderPublicRoute } from "@/lib/platform/render";
import { PAGES_MODULE_ID } from "@/modules/pages/manifest";

export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  if (!(await isModuleEnabled(db, PAGES_MODULE_ID))) {
    return renderPublicRoute({ kind: "not-found" }, request, { status: 404 });
  }
  return renderPublicRoute({ kind: "page-list" }, request);
}
