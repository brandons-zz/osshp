// GET /tags/[slug] — published posts carrying a tag, rendered through the theme's
// tag target (falls back to post-list in the theme engine if a theme ships no tag
// template). Only published posts appear (§3.3).

import { getDb } from "@/lib/db/client";
import { isModuleEnabled } from "@/lib/platform";
import { renderPublicRoute } from "@/lib/platform/render";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  if (!(await isModuleEnabled(getDb(), BLOG_MODULE_ID))) {
    return renderPublicRoute({ kind: "not-found" }, request, { status: 404 });
  }
  const { slug } = await params;
  return renderPublicRoute({ kind: "tag", slug }, request);
}
