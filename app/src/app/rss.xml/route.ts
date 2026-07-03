// GET /rss.xml — RSS 2.0 feed of published blog posts, newest first.
//
// /rss.xml is pre-listed in the public access allowlist (access.ts PUBLIC_EXACT)
// and is the URL the Blog module's footer hook already links to. Inert when the
// Blog module is disabled (returns HTTP 404, consistent with the /blog route).
//
// The feed reflects only PUBLISHED (or past-scheduled-auto-revealed) posts via
// listPublishedPosts — the same published-only boundary that governs the theme-
// rendered post-list (content/posts.ts VISIBLE_FILTER, §3.3). Draft and future-
// dated scheduled posts never appear.
//
// config.origin is the operator-pinned site origin (OSSHP_ORIGIN env var). It
// is never derived from a request header — same security rule as the auth layer
// (auth-security-assessment W2 / NO-GO #4).

import { getDb } from "@/lib/db/client";
import { isModuleEnabled } from "@/lib/platform";
import { listPublishedPosts } from "@/lib/content/posts";
import { getPublicSettings } from "@/lib/content/settings";
import { buildRssFeed } from "@/lib/content/feed";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { config } from "@/lib/config";

export async function GET(): Promise<Response> {
  const db = getDb();

  if (!(await isModuleEnabled(db, BLOG_MODULE_ID))) {
    return new Response("Not found", { status: 404 });
  }

  const [posts, settings] = await Promise.all([
    // Blog stream only: articles always; photo-posts only when show_in_blog=true
    // (consistent with the /blog listing rule — same inclusion predicate).
    listPublishedPosts(db, { blogStream: true }),
    getPublicSettings(db),
  ]);

  // Strip a trailing slash from the origin so item URLs never get a double slash.
  const origin = config.origin.replace(/\/$/, "");

  const feedPosts = posts.map((p) => ({
    title: p.title,
    slug: p.slug,
    excerpt: p.excerpt,
    publishedAt: p.publishDate ?? p.createdAt,
    type: p.type,
  }));

  const xml = buildRssFeed(
    feedPosts,
    {
      title:
        typeof settings["site.title"] === "string" ? settings["site.title"] : "",
      description:
        typeof settings["site.description"] === "string"
          ? settings["site.description"]
          : "",
      locale:
        typeof settings["site.locale"] === "string"
          ? settings["site.locale"]
          : "en",
    },
    origin,
  );

  return new Response(xml, {
    status: 200,
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
