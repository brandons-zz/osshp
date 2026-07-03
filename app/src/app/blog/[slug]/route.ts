// GET /blog/[slug] — a single published ARTICLE, rendered through the theme.
//
// Only PUBLISHED posts of type 'article' are reachable here:
//   * An unknown or unpublished slug renders the theme not-found (404).
//   * A photo-post slug renders 404 — photo-posts live at /photos/<slug>, not
//     here. Their single canonical URL is /photos/<slug>; this route NEVER
//     serves a photo-post regardless of the show_in_blog flag (that flag governs
//     listing inclusion only, not this second URL).
// Inert when the Blog module is disabled.

import { getDb } from "@/lib/db/client";
import { getPublishedPostBySlug } from "@/lib/content/posts";
import { isModuleEnabled } from "@/lib/platform";
import { renderPublicRoute } from "@/lib/platform/render";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const db = getDb();
  if (!(await isModuleEnabled(db, BLOG_MODULE_ID))) {
    return renderPublicRoute({ kind: "not-found" }, request, { status: 404 });
  }
  const { slug } = await params;
  const post = await getPublishedPostBySlug(db, slug);
  // Photo-posts are not served at /blog/<slug>; their home is /photos/<slug>.
  if (!post || post.type === "photo-post") {
    return renderPublicRoute({ kind: "not-found" }, request, { status: 404 });
  }
  return renderPublicRoute({ kind: "post", slug }, request);
}
