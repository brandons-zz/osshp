// GET /tags — the tag index (issue 061). Lists every tag carrying at least one
// VISIBLE post (with its count), each linking to /tags/<slug>. Mirrors the
// /pages index pattern (src/app/pages/route.ts): gate on the owning module,
// then hand off to the theme via renderPublicRoute. Gated on the Blog module
// (same as /tags/[slug]) since tags only ever apply to blog posts.

import { getDb } from "@/lib/db/client";
import { isModuleEnabled } from "@/lib/platform";
import { renderPublicRoute } from "@/lib/platform/render";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";

export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  if (!(await isModuleEnabled(db, BLOG_MODULE_ID))) {
    return renderPublicRoute({ kind: "not-found" }, request, { status: 404 });
  }
  return renderPublicRoute({ kind: "tag-list" }, request);
}
