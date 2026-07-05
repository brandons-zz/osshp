// Tests for lib/content/feed.ts — the RSS 2.0 feed generator.
//
// Two test groups:
//  1. Pure unit tests for buildRssFeed: XML structure, required elements,
//     XML-escaping of special characters.
//  2. Integration with the database layer: verifies that a draft and a
//     future-scheduled post are ABSENT from the feed output after being
//     filtered by listPublishedPosts — the published-only boundary (§3.3).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildRssFeed, filterFeedPostsByEnabledModules, type FeedPost, type FeedSite } from "../feed";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createPost, listPublishedPosts } from "../posts";

const SITE: FeedSite = { title: "Test Site", description: "A test blog", locale: "en" };
const ORIGIN = "https://example.com";

// ── Pure XML generation ──────────────────────────────────────────────────────

test("buildRssFeed generates RSS 2.0 prologue and required channel metadata", () => {
  const xml = buildRssFeed([], SITE, ORIGIN);
  expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  expect(xml).toContain('<rss version="2.0"');
  expect(xml).toContain("xmlns:atom=");
  expect(xml).toContain("<title>Test Site</title>");
  expect(xml).toContain(`<link>${ORIGIN}</link>`);
  expect(xml).toContain("<description>A test blog</description>");
  expect(xml).toContain("<language>en</language>");
});

test("buildRssFeed includes atom:link self-referential element", () => {
  const xml = buildRssFeed([], SITE, ORIGIN);
  expect(xml).toContain(`href="${ORIGIN}/rss.xml"`);
  expect(xml).toContain('rel="self"');
  expect(xml).toContain('type="application/rss+xml"');
});

test("buildRssFeed includes a post with title, link, guid, pubDate, and description", () => {
  const posts: FeedPost[] = [
    {
      title: "My First Post",
      slug: "my-first-post",
      excerpt: "A short excerpt.",
      publishedAt: "2026-06-01T00:00:00.000Z",
    },
  ];
  const xml = buildRssFeed(posts, SITE, ORIGIN);
  expect(xml).toContain("<item>");
  expect(xml).toContain("<title>My First Post</title>");
  expect(xml).toContain(`<link>${ORIGIN}/blog/my-first-post</link>`);
  expect(xml).toContain(`<guid isPermaLink="true">${ORIGIN}/blog/my-first-post</guid>`);
  expect(xml).toContain("<description>A short excerpt.</description>");
  expect(xml).toContain("<pubDate>");
});

test("buildRssFeed produces no <item> elements for an empty post list", () => {
  const xml = buildRssFeed([], SITE, ORIGIN);
  expect(xml).not.toContain("<item>");
});

test("buildRssFeed escapes XML special characters in title and excerpt", () => {
  const posts: FeedPost[] = [
    {
      title: 'Post & <title> "Test"',
      slug: "post-title",
      excerpt: 'Excerpt with <html> & "quotes"',
      publishedAt: "2026-06-01T00:00:00.000Z",
    },
  ];
  const xml = buildRssFeed(posts, SITE, ORIGIN);
  // Escaped forms must be present.
  expect(xml).toContain("Post &amp; &lt;title&gt; &quot;Test&quot;");
  expect(xml).toContain("&lt;html&gt; &amp; &quot;quotes&quot;");
  // Raw unescaped forms must NOT appear in the XML.
  expect(xml).not.toContain('Post & <title>');
  expect(xml).not.toContain('<html> &');
});

test("buildRssFeed falls back to siteTitle when description is empty", () => {
  const xml = buildRssFeed([], { title: "My Site", description: "", locale: "en" }, ORIGIN);
  expect(xml).toContain("<description>My Site</description>");
});

// ── Photo-post URL in feed ────────────────────────────────────────────────────

test("buildRssFeed uses /photos/<slug> for photo-post items", () => {
  const posts: FeedPost[] = [
    {
      title: "Alpine Morning",
      slug: "alpine-morning",
      excerpt: "A sunrise photo.",
      publishedAt: "2026-06-01T00:00:00.000Z",
      type: "photo-post",
    },
  ];
  const xml = buildRssFeed(posts, SITE, ORIGIN);
  expect(xml).toContain(`<link>${ORIGIN}/photos/alpine-morning</link>`);
  expect(xml).toContain(
    `<guid isPermaLink="true">${ORIGIN}/photos/alpine-morning</guid>`,
  );
  // Must NOT use /blog for a photo-post.
  expect(xml).not.toContain(`${ORIGIN}/blog/alpine-morning`);
});

test("buildRssFeed uses /blog/<slug> for article items (unchanged)", () => {
  const posts: FeedPost[] = [
    {
      title: "My Article",
      slug: "my-article",
      excerpt: "An article.",
      publishedAt: "2026-06-01T00:00:00.000Z",
      type: "article",
    },
  ];
  const xml = buildRssFeed(posts, SITE, ORIGIN);
  expect(xml).toContain(`<link>${ORIGIN}/blog/my-article</link>`);
});

test("buildRssFeed defaults to /blog/<slug> when type is omitted", () => {
  const posts: FeedPost[] = [
    {
      title: "No Type Post",
      slug: "no-type-post",
      excerpt: "",
      publishedAt: "2026-06-01T00:00:00.000Z",
      // type omitted — backward-compatible: treat as article
    },
  ];
  const xml = buildRssFeed(posts, SITE, ORIGIN);
  expect(xml).toContain(`<link>${ORIGIN}/blog/no-type-post</link>`);
});

// ── filterFeedPostsByEnabledModules — issue 074 ──────────────────────────────
//
// Regression coverage for the /rss.xml route's enabled-module gap: a photo-post
// opted into the blog stream (show_in_blog=true) previously appeared in the
// feed regardless of the Photos module's enablement state, even though its own
// canonical /photos/<slug> route already 404s while Photos is disabled.

test("filterFeedPostsByEnabledModules drops photo-post entries when Photos is disabled", () => {
  const posts: FeedPost[] = [
    { title: "An Article", slug: "an-article", excerpt: "", publishedAt: "2026-06-01T00:00:00.000Z", type: "article" },
    { title: "A Photo Post", slug: "a-photo-post", excerpt: "", publishedAt: "2026-06-01T00:00:00.000Z", type: "photo-post" },
  ];
  const filtered = filterFeedPostsByEnabledModules(posts, false);
  expect(filtered.map((p) => p.slug)).toEqual(["an-article"]);
});

test("filterFeedPostsByEnabledModules keeps photo-post entries when Photos is enabled", () => {
  const posts: FeedPost[] = [
    { title: "An Article", slug: "an-article", excerpt: "", publishedAt: "2026-06-01T00:00:00.000Z", type: "article" },
    { title: "A Photo Post", slug: "a-photo-post", excerpt: "", publishedAt: "2026-06-01T00:00:00.000Z", type: "photo-post" },
  ];
  const filtered = filterFeedPostsByEnabledModules(posts, true);
  expect(filtered.map((p) => p.slug)).toEqual(["an-article", "a-photo-post"]);
});

test("filterFeedPostsByEnabledModules never drops an article (type-omitted entries treated as article)", () => {
  const posts: FeedPost[] = [
    { title: "No Type", slug: "no-type", excerpt: "", publishedAt: "2026-06-01T00:00:00.000Z" },
  ];
  expect(filterFeedPostsByEnabledModules(posts, false).map((p) => p.slug)).toEqual(["no-type"]);
});

// ── Published-only filter — draft and future-scheduled posts absent ──────────
//
// The filtering is enforced by listPublishedPosts (VISIBLE_FILTER in posts.ts).
// These tests exercise the full pipeline: create posts with different statuses →
// call listPublishedPosts → pipe to buildRssFeed → assert presence/absence.

describe("published-only filter: draft and future-scheduled excluded", () => {
  let h: TestDb;
  let db: Db;

  beforeEach(async () => {
    h = await createTestDb();
    db = h.db;
  });
  afterEach(() => h.close());

  test("draft post is absent from the feed; published post is present", async () => {
    await createPost(db, {
      title: "Published Post",
      slug: "published-post",
      body: "body",
      status: "published",
      publishDate: "2026-06-01T00:00:00.000Z",
      excerpt: "Published excerpt",
    });
    await createPost(db, {
      title: "Draft Post",
      slug: "draft-post",
      body: "body",
      status: "draft",
      excerpt: "Draft excerpt",
    });

    const posts = await listPublishedPosts(db);
    const feedPosts = posts.map((p) => ({
      title: p.title,
      slug: p.slug,
      excerpt: p.excerpt,
      publishedAt: p.publishDate ?? p.createdAt,
    }));
    const xml = buildRssFeed(feedPosts, SITE, ORIGIN);

    expect(xml).toContain("Published Post");
    expect(xml).toContain("published-post");
    // The draft must not appear in the feed.
    expect(xml).not.toContain("Draft Post");
    expect(xml).not.toContain("draft-post");
  });

  test("future-scheduled post is absent from the feed", async () => {
    await createPost(db, {
      title: "Future Scheduled",
      slug: "future-scheduled",
      body: "body",
      status: "scheduled",
      publishDate: "2099-01-01T00:00:00.000Z", // far future — still hidden
      excerpt: "Future excerpt",
    });

    const posts = await listPublishedPosts(db);
    const feedPosts = posts.map((p) => ({
      title: p.title,
      slug: p.slug,
      excerpt: p.excerpt,
      publishedAt: p.publishDate ?? p.createdAt,
    }));
    const xml = buildRssFeed(feedPosts, SITE, ORIGIN);

    expect(xml).not.toContain("Future Scheduled");
    expect(xml).not.toContain("future-scheduled");
  });

  test("past-scheduled post (auto-revealed) IS present in the feed", async () => {
    await createPost(db, {
      title: "Past Scheduled",
      slug: "past-scheduled",
      body: "body",
      status: "scheduled",
      publishDate: "2020-01-01T00:00:00.000Z", // past — auto-reveals
      excerpt: "Past scheduled excerpt",
    });

    const posts = await listPublishedPosts(db);
    const feedPosts = posts.map((p) => ({
      title: p.title,
      slug: p.slug,
      excerpt: p.excerpt,
      publishedAt: p.publishDate ?? p.createdAt,
    }));
    const xml = buildRssFeed(feedPosts, SITE, ORIGIN);

    expect(xml).toContain("Past Scheduled");
    expect(xml).toContain("past-scheduled");
  });
});
