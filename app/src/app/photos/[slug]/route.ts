// GET /photos/[slug] — a single published photo-post, rendered through the
// theme via the `photo-post` route kind. Only photo-post type posts are served
// here; article-type posts live at /blog/[slug]. Unknown, unpublished, or
// article-type slugs render the theme not-found with a 404 status. Inert when
// the Photos module is disabled.
//
// The `photo-post` route kind causes buildSiteIdentity to pass content.kind
// "photo-post" to the theme, which the editorial theme uses to render a back
// affordance pointing to /photos ("← Photographs") rather than /blog
// ("← Writing"). The route information in ThemeRenderContext.route carries the
// kind rather than the post type so the theme never reads raw DB fields.

import { getDb } from "@/lib/db/client";
import { getPublishedPostBySlug } from "@/lib/content/posts";
import { isModuleEnabled } from "@/lib/platform";
import { renderPublicRoute } from "@/lib/platform/render";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const db = getDb();
  if (!(await isModuleEnabled(db, PHOTOS_MODULE_ID))) {
    return renderPublicRoute({ kind: "not-found" }, request, { status: 404 });
  }
  const { slug } = await params;
  const post = await getPublishedPostBySlug(db, slug);
  // Only photo-post type posts are served via this route. Article posts belong
  // at /blog/[slug]; serving them here would create duplicate canonical URLs.
  if (!post || post.type !== "photo-post") {
    return renderPublicRoute({ kind: "not-found" }, request, { status: 404 });
  }
  return renderPublicRoute({ kind: "photo-post", slug }, request);
}
