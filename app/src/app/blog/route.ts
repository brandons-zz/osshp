// GET /blog — the Blog module's public post-list, rendered through the theme.
// Inert when the Blog module is disabled (renders the theme not-found, §3.1 rule 4).

import { getDb } from "@/lib/db/client";
import { isModuleEnabled } from "@/lib/platform";
import { renderPublicRoute } from "@/lib/platform/render";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";

export async function GET(request: Request): Promise<Response> {
  if (!(await isModuleEnabled(getDb(), BLOG_MODULE_ID))) {
    return renderPublicRoute({ kind: "not-found" }, request, { status: 404 });
  }
  return renderPublicRoute({ kind: "post-list" }, request);
}
