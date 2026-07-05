// GET /pages/[slug] — a single published page, rendered through the theme.
// Only PUBLISHED pages are reachable (the theme materialization boundary, §3.3):
// an unknown or draft slug renders the theme not-found with a 404 status.
// Inert when the Pages module is disabled.

import { getDb } from "@/lib/db/client";
import { getPublishedPageBySlug } from "@/lib/content/pages";
import { isModuleEnabled } from "@/lib/platform";
import { renderPublicRoute } from "@/lib/platform/render";
import { PAGES_MODULE_ID } from "@/modules/pages/manifest";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const db = getDb();
  if (!(await isModuleEnabled(db, PAGES_MODULE_ID))) {
    return renderPublicRoute({ kind: "not-found" }, request, { status: 404 });
  }
  const { slug } = await params;
  const page = await getPublishedPageBySlug(db, slug);
  return renderPublicRoute(
    { kind: "page", slug },
    request,
    { status: page ? 200 : 404 },
  );
}
