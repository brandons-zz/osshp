// Sitemap URL generation helpers (pure, no I/O, testable in isolation).
//
// buildSitemapUrls — compute the full URL list given enabled modules + published
//   content slugs; applies the same published-only + module-enabled guards as the
//   theme-rendered pages (content/posts.ts VISIBLE_FILTER / §3.3, module-contract
//   §3.1 rule 4).
// renderSitemapXml — format the URL list as a well-formed sitemap XML document.
//
// The route handler at app/sitemap.xml/route.ts calls these after DB I/O; tests
// import and exercise these directly without any Next.js or DB machinery.

import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";
import { PAGES_MODULE_ID } from "@/modules/pages/manifest";

export interface SitemapOpts {
  blogPostSlugs: string[];
  /** Individual photo-post slugs for /photos/<slug> entries. */
  photoPostSlugs: string[];
  pageSlugs: string[];
  hasPhotos: boolean;
}

/**
 * Build the sitemap URL entry list given the enabled module ids and their
 * published content. Pure — no DB I/O. Exported for unit testing.
 */
export function buildSitemapUrls(
  origin: string,
  enabledModuleIds: readonly string[],
  opts: SitemapOpts,
): string[] {
  const o = origin.replace(/\/$/, "");
  const urls: string[] = [`${o}/`];

  const blogEnabled = enabledModuleIds.includes(BLOG_MODULE_ID);
  const photosEnabled = enabledModuleIds.includes(PHOTOS_MODULE_ID);
  const pagesEnabled = enabledModuleIds.includes(PAGES_MODULE_ID);

  if (blogEnabled) {
    urls.push(`${o}/blog`);
    for (const slug of opts.blogPostSlugs) {
      urls.push(`${o}/blog/${slug}`);
    }
  }

  if (photosEnabled && opts.hasPhotos) {
    urls.push(`${o}/photos`);
    for (const slug of opts.photoPostSlugs) {
      urls.push(`${o}/photos/${slug}`);
    }
  }

  if (pagesEnabled) {
    // /pages index (V-010) — listed first so crawlers discover it, then the
    // individual pages below.
    if (opts.pageSlugs.length > 0) {
      urls.push(`${o}/pages`);
    }
    for (const slug of opts.pageSlugs) {
      urls.push(`${o}/pages/${slug}`);
    }
  }

  return urls;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Render a list of absolute URLs as a well-formed sitemap XML document. */
export function renderSitemapXml(urls: string[]): string {
  const items = urls
    .map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    items,
    "</urlset>",
    "",
  ].join("\n");
}
