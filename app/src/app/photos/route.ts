// GET /photos — the Photos module's public lightbox gallery grid, rendered
// through the theme via the `photo-list` render target. Inert when the Photos
// module is disabled (renders the theme not-found, §3.1 rule 4).

import { getDb } from "@/lib/db/client";
import { isModuleEnabled } from "@/lib/platform";
import { renderPublicRoute } from "@/lib/platform/render";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";

export async function GET(request: Request): Promise<Response> {
  if (!(await isModuleEnabled(getDb(), PHOTOS_MODULE_ID))) {
    return renderPublicRoute({ kind: "not-found" }, request, { status: 404 });
  }
  return renderPublicRoute({ kind: "photo-list" }, request);
}
