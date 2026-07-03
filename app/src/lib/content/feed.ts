// RSS 2.0 feed generation — pure, no I/O.
//
// Converts already-published posts (status-filtered by listPublishedPosts
// before they arrive here) and the operator's public site identity into a
// well-formed RSS 2.0 XML string. The published-only contract §3.3 is
// enforced upstream (listPublishedPosts / VISIBLE_FILTER), not here — this
// function trusts its input list contains only publicly-visible posts.
//
// No external deps: the XML is hand-assembled. The only moving parts are XML
// escaping and RFC 822 date formatting, both self-contained below.

/** Escape XML special characters so text content is well-formed. */
function escXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** ISO 8601 → RFC 822 date string, as required by the RSS <pubDate> element. */
function toRfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

// ── Public interfaces ────────────────────────────────────────────────────────

export interface FeedSite {
  /** Operator-configured site title (site.title public setting). */
  title: string;
  /** Operator-configured site description (site.description public setting). */
  description: string;
  /** BCP 47 locale (site.locale public setting, e.g. "en"). */
  locale: string;
}

export interface FeedPost {
  title: string;
  slug: string;
  excerpt: string;
  /** ISO 8601 timestamp — the post's publishDate, or createdAt as fallback. */
  publishedAt: string;
  /**
   * Post type — determines the item link URL. 'photo-post' items link to
   * /photos/<slug>; all other types link to /blog/<slug>. Defaults to 'article'
   * when omitted, preserving backward-compatible behavior.
   */
  type?: "article" | "photo-post";
}

/**
 * Build a well-formed RSS 2.0 feed XML string.
 *
 * `origin` is the scheme + host of the running site (e.g. "https://steili.com")
 * and is used to construct absolute <link> and <guid> URLs that feed readers
 * require. It must NOT have a trailing slash.
 *
 * Only already-filtered published posts should be passed — this function does
 * no status filtering itself; the filtering boundary lives in listPublishedPosts
 * (content/posts.ts VISIBLE_FILTER, theme-rendering-contract §3.3).
 */
export function buildRssFeed(
  posts: FeedPost[],
  site: FeedSite,
  origin: string,
): string {
  const feedUrl = `${origin}/rss.xml`;
  const siteTitle = site.title || "osshp";
  const siteDescription = site.description || siteTitle;

  const items = posts
    .map((p) => {
      // Photo-posts appear in the blog stream with their /photos/<slug> home URL.
      const link =
        p.type === "photo-post"
          ? `${origin}/photos/${p.slug}`
          : `${origin}/blog/${p.slug}`;
      const lines = [
        "    <item>",
        `      <title>${escXml(p.title)}</title>`,
        `      <link>${escXml(link)}</link>`,
        `      <guid isPermaLink="true">${escXml(link)}</guid>`,
        `      <pubDate>${escXml(toRfc822(p.publishedAt))}</pubDate>`,
      ];
      if (p.excerpt) {
        lines.push(`      <description>${escXml(p.excerpt)}</description>`);
      }
      lines.push("    </item>");
      return lines.join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escXml(siteTitle)}</title>`,
    `    <link>${escXml(origin)}</link>`,
    `    <description>${escXml(siteDescription)}</description>`,
    `    <language>${escXml(site.locale || "en")}</language>`,
    `    <atom:link href="${escXml(feedUrl)}" rel="self" type="application/rss+xml"/>`,
    items,
    "  </channel>",
    "</rss>",
  ].join("\n");
}
