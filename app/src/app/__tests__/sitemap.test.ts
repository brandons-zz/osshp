// Sitemap URL generation — unit tests for buildSitemapUrls and renderSitemapXml.
//
// These tests exercise the published-only + module-enabled filtering at the pure
// function level (no DB, no Next.js) — the key properties that must hold at
// runtime: (a) a known published post appears; (b) a draft does NOT appear;
// (c) with Blog disabled, blog URLs are excluded; (d) the XML is well-formed.
//
// Photo-post coverage added for the show_in_blog feature: individual
// /photos/<slug> entries appear for ALL published photo-posts (regardless of
// show_in_blog); that flag only affects the /blog listing.

import { describe, expect, test } from "bun:test";
import { buildSitemapUrls, renderSitemapXml } from "@/lib/sitemap";

const ORIGIN = "https://example.com";

describe("buildSitemapUrls — published-only filtering", () => {
  test("home is always included", () => {
    const urls = buildSitemapUrls(ORIGIN, [], {
      blogPostSlugs: [],
      photoPostSlugs: [],
      pageSlugs: [],
      hasPhotos: false,
    });
    expect(urls).toContain("https://example.com/");
  });

  test("includes blog index + post URLs when Blog is enabled", () => {
    const urls = buildSitemapUrls(ORIGIN, ["blog"], {
      blogPostSlugs: ["my-post", "another-post"],
      photoPostSlugs: [],
      pageSlugs: [],
      hasPhotos: false,
    });
    expect(urls).toContain("https://example.com/blog");
    expect(urls).toContain("https://example.com/blog/my-post");
    expect(urls).toContain("https://example.com/blog/another-post");
  });

  test("excludes all blog URLs when Blog is disabled (module-gated)", () => {
    const urls = buildSitemapUrls(ORIGIN, [], {
      blogPostSlugs: ["my-post"],
      photoPostSlugs: [],
      pageSlugs: [],
      hasPhotos: false,
    });
    expect(urls).not.toContain("https://example.com/blog");
    expect(urls).not.toContain("https://example.com/blog/my-post");
  });

  test("includes /photos when Photos enabled and there are photo posts", () => {
    const urls = buildSitemapUrls(ORIGIN, ["photos"], {
      blogPostSlugs: [],
      photoPostSlugs: ["sunrise"],
      pageSlugs: [],
      hasPhotos: true,
    });
    expect(urls).toContain("https://example.com/photos");
  });

  test("includes individual /photos/<slug> entries when Photos enabled", () => {
    const urls = buildSitemapUrls(ORIGIN, ["photos"], {
      blogPostSlugs: [],
      photoPostSlugs: ["alpine-morning", "coast-sunset"],
      pageSlugs: [],
      hasPhotos: true,
    });
    expect(urls).toContain("https://example.com/photos/alpine-morning");
    expect(urls).toContain("https://example.com/photos/coast-sunset");
  });

  test("excludes /photos/* when Photos disabled (module-gated)", () => {
    const urls = buildSitemapUrls(ORIGIN, [], {
      blogPostSlugs: [],
      photoPostSlugs: ["alpine-morning"],
      pageSlugs: [],
      hasPhotos: true,
    });
    expect(urls).not.toContain("https://example.com/photos");
    expect(urls).not.toContain("https://example.com/photos/alpine-morning");
  });

  test("excludes /photos when Photos enabled but no photo posts published", () => {
    const urls = buildSitemapUrls(ORIGIN, ["photos"], {
      blogPostSlugs: [],
      photoPostSlugs: [],
      pageSlugs: [],
      hasPhotos: false,
    });
    expect(urls).not.toContain("https://example.com/photos");
  });

  test("photo-post slugs are NOT in blog/* entries", () => {
    const urls = buildSitemapUrls(ORIGIN, ["blog", "photos"], {
      blogPostSlugs: ["article-one"],
      photoPostSlugs: ["photo-one"],
      pageSlugs: [],
      hasPhotos: true,
    });
    expect(urls).toContain("https://example.com/blog/article-one");
    expect(urls).not.toContain("https://example.com/blog/photo-one");
    expect(urls).toContain("https://example.com/photos/photo-one");
  });

  test("includes page URLs when Pages is enabled", () => {
    const urls = buildSitemapUrls(ORIGIN, ["pages"], {
      blogPostSlugs: [],
      photoPostSlugs: [],
      pageSlugs: ["about", "portfolio"],
      hasPhotos: false,
    });
    expect(urls).toContain("https://example.com/pages/about");
    expect(urls).toContain("https://example.com/pages/portfolio");
  });

  test("excludes page URLs when Pages is disabled (module-gated)", () => {
    const urls = buildSitemapUrls(ORIGIN, [], {
      blogPostSlugs: [],
      photoPostSlugs: [],
      pageSlugs: ["about"],
      hasPhotos: false,
    });
    expect(urls).not.toContain("https://example.com/pages/about");
  });

  test("trailing slash on origin is stripped cleanly", () => {
    const urls = buildSitemapUrls("https://example.com/", ["blog"], {
      blogPostSlugs: ["post"],
      photoPostSlugs: [],
      pageSlugs: [],
      hasPhotos: false,
    });
    // Should not produce double slashes.
    for (const u of urls) {
      expect(u).not.toContain("//blog");
      expect(u).not.toContain("//post");
    }
    expect(urls).toContain("https://example.com/blog/post");
  });

  test("all three modules enabled — full URL set", () => {
    const urls = buildSitemapUrls(ORIGIN, ["blog", "photos", "pages"], {
      blogPostSlugs: ["post-a"],
      photoPostSlugs: ["photo-a"],
      pageSlugs: ["about"],
      hasPhotos: true,
    });
    expect(urls).toContain("https://example.com/");
    expect(urls).toContain("https://example.com/blog");
    expect(urls).toContain("https://example.com/blog/post-a");
    expect(urls).toContain("https://example.com/photos");
    expect(urls).toContain("https://example.com/photos/photo-a");
    expect(urls).toContain("https://example.com/pages/about");
  });
});

describe("renderSitemapXml — well-formed XML output", () => {
  test("produces the correct XML declaration and urlset element", () => {
    const xml = renderSitemapXml(["https://example.com/"]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml).toContain("</urlset>");
  });

  test("wraps each URL in <url><loc>…</loc></url>", () => {
    const xml = renderSitemapXml([
      "https://example.com/",
      "https://example.com/blog/post",
    ]);
    expect(xml).toContain(
      "<url><loc>https://example.com/</loc></url>",
    );
    expect(xml).toContain(
      "<url><loc>https://example.com/blog/post</loc></url>",
    );
  });

  test("XML-escapes special characters in URLs", () => {
    const xml = renderSitemapXml(["https://example.com/path?a=1&b=2"]);
    expect(xml).toContain("&amp;");
    expect(xml).not.toContain("?a=1&b=2"); // raw & must not appear
  });
});
