// GET /sitemap.xml — machine-readable URL list for search engine crawlers.
//
// Serves only published, module-enabled URLs (no drafts/scheduled). The URL
// list is built by the pure helpers in lib/sitemap (testable without DB).
// /sitemap.xml is in PUBLIC_EXACT (access.ts) so no auth is required.
//
// The origin is taken from OSSHP_ORIGIN (config.origin) — never from request
// headers (same security rule as the RSS feed, auth-assessment W2 / NO-GO #4).

// Force dynamic rendering — OSSHP_ORIGIN and DB content are runtime values.
// Sitemap must reflect the live published state, not a build-time snapshot.
export const dynamic = "force-dynamic";

import { getDb } from "@/lib/db/client";
import { config } from "@/lib/config";
import { getEnabledModuleIds } from "@/lib/module";
import { listPublishedPosts } from "@/lib/content/posts";
import { listPublishedPages } from "@/lib/content/pages";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";
import { buildSitemapUrls, renderSitemapXml } from "@/lib/sitemap";

export async function GET(): Promise<Response> {
  const db = getDb();
  const origin = config.origin;
  const [enabledIds, posts, pages] = await Promise.all([
    getEnabledModuleIds(db),
    listPublishedPosts(db),
    listPublishedPages(db),
  ]);

  // Blog post slugs — only articles (not photo-posts). Guard here too so the
  // array is empty when Blog is off (buildSitemapUrls also gates on module state).
  const blogPostSlugs = enabledIds.includes(BLOG_MODULE_ID)
    ? posts.filter((p) => p.type === "article").map((p) => p.slug)
    : [];

  // Photo-post slugs — ALL published photo-posts, each indexable at /photos/<slug>.
  // Independent of the show_in_blog flag (that governs blog listing only).
  const photoPostSlugs = enabledIds.includes(PHOTOS_MODULE_ID)
    ? posts.filter((p) => p.type === "photo-post").map((p) => p.slug)
    : [];

  // Photos index is included only when there is at least one published photo post.
  const hasPhotos =
    enabledIds.includes(PHOTOS_MODULE_ID) &&
    posts.some((p) => p.type === "photo-post");

  const urls = buildSitemapUrls(origin, enabledIds, {
    blogPostSlugs,
    photoPostSlugs,
    pageSlugs: pages.map((p) => p.slug),
    hasPhotos,
  });

  return new Response(renderSitemapXml(urls), {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}
