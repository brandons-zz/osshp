import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import {
  createAdminUser,
  createPage,
  createPost,
  setSetting,
} from "@/lib/content";
import { buildRenderContext, selectFeatured, FEATURED_CAP } from "../context";
import type { PublicPostSummary } from "../types";

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb({ seed: true });
  db = h.db;
});
afterEach(() => h.close());

// Recognizable secret tokens — if ANY appears in the serialized context, the
// public-only boundary (§3.1) has been breached.
const SMTP_SECRET = "SMTP_SECRET_a1b2c3";
const PW_HASH = "PWHASH_SECRET_d4e5f6";
const TOTP_SECRET = "TOTP_SECRET_g7h8i9";
const RECOVERY = "RECOVERY_SECRET_j0k1l2";

async function seedSecrets(): Promise<void> {
  await setSetting(db, "site.title", "My Public Site", "public");
  await setSetting(db, "branding.accent", "#2563eb", "public");
  await setSetting(db, "secrets.smtp", { pass: SMTP_SECRET }, "admin");
  await setSetting(db, "site.activeTheme", "editorial", "admin");
  await createAdminUser(db, {
    passwordHash: PW_HASH,
    totpSecret: TOTP_SECRET,
    recoveryCodes: [RECOVERY],
  });
}

test("admin/secret material is unreachable from the context BY CONSTRUCTION", async () => {
  await seedSecrets();
  const ctx = await buildRenderContext(db, { kind: "home" });

  // Public identity comes through …
  expect(ctx.site.title).toBe("My Public Site");

  // … but nothing admin/secret does. The whole context serialized contains none
  // of the secret tokens and none of the admin-only setting key.
  const blob = JSON.stringify(ctx);
  expect(blob).not.toContain(SMTP_SECRET);
  expect(blob).not.toContain(PW_HASH);
  expect(blob).not.toContain(TOTP_SECRET);
  expect(blob).not.toContain(RECOVERY);
  expect(blob).not.toContain("activeTheme");
  expect(blob).not.toContain("secrets.smtp");
});

test("only PUBLISHED content materializes into the context (§3.3)", async () => {
  await createPost(db, {
    title: "Published One",
    slug: "published-one",
    body: "hello",
    status: "published",
  });
  await createPost(db, {
    title: "Draft Two",
    slug: "draft-two",
    body: "secret draft",
    status: "draft",
  });

  const ctx = await buildRenderContext(db, { kind: "home" });
  if (ctx.content.kind !== "home") throw new Error("expected home content");
  const titles = ctx.content.posts.map((p) => p.title);
  expect(titles).toContain("Published One");
  expect(titles).not.toContain("Draft Two");
});

test("post bodies are sanitized before entering the context (§9)", async () => {
  await createPost(db, {
    title: "XSS Attempt",
    slug: "xss",
    body: "# Hi\n\n<script>alert('pwn')</script>\n",
    status: "published",
  });

  const ctx = await buildRenderContext(db, { kind: "post", slug: "xss" });
  if (ctx.content.kind !== "post") throw new Error("expected post content");
  expect(ctx.content.post.bodyHtml).not.toContain("<script");
  expect(ctx.content.post.bodyHtml).not.toContain("alert(");
  expect(ctx.content.post.bodyHtml).toContain("<h1>");
});

test("a missing published post resolves to a not-found route", async () => {
  const ctx = await buildRenderContext(db, { kind: "post", slug: "nope" });
  expect(ctx.route.kind).toBe("not-found");
});

test("scheme resolves: visitor override beats operator default", async () => {
  await setSetting(db, "branding.defaultScheme", "light", "public");
  const ctx = await buildRenderContext(
    db,
    { kind: "home" },
    { persistedScheme: "dark" },
  );
  expect(ctx.scheme).toBe("dark");
});

// ── Canonical URL / Defect-1 regression guard ────────────────────────────────
// The pages/[slug] route previously passed canonicalUrl: `/pages/${slug}` (a
// relative string) to renderPublicRoute, overriding defaultCanonical(). The fix
// removes the explicit override so defaultCanonical() runs. These tests verify
// the canonical URL is absolute (uses OSSHP_ORIGIN) when no override is given,
// which is the state the FIXED route.ts produces.

test("page canonical URL is absolute (uses OSSHP_ORIGIN) when no explicit override is given", async () => {
  const savedOrigin = process.env.OSSHP_ORIGIN;
  process.env.OSSHP_ORIGIN = "https://test.example.com";
  try {
    const ctx = await buildRenderContext(db, { kind: "page", slug: "about" });
    expect(ctx.route.canonicalUrl).toBe("https://test.example.com/pages/about");
    expect(ctx.route.canonicalUrl).toMatch(/^https?:\/\//);
  } finally {
    process.env.OSSHP_ORIGIN = savedOrigin;
  }
});

test("post canonical URL is absolute (uses OSSHP_ORIGIN) — regression baseline", async () => {
  const savedOrigin = process.env.OSSHP_ORIGIN;
  process.env.OSSHP_ORIGIN = "https://test.example.com";
  try {
    // A blog post route never passed an explicit canonicalUrl; it already used
    // defaultCanonical. Verify this continues to produce an absolute URL so we
    // can confirm page parity with post.
    const ctx = await buildRenderContext(db, { kind: "post", slug: "anything" });
    // A missing slug resolves to not-found; the canonical is /404.
    expect(ctx.route.canonicalUrl).toMatch(/^https?:\/\//);
  } finally {
    process.env.OSSHP_ORIGIN = savedOrigin;
  }
});

// ── D1 regression — malformed site.nav does not crash the public site ─────────
// Defect class: bare Array.isArray(nav) ? (nav as ...) : [] cast passes nulls,
// numbers, and objects missing required fields through to the theme's .map(),
// causing a 500 on the public home page. The fix is a per-item filter in
// buildSiteIdentity(). This test encodes the regression contract.

test("D1 — malformed site.nav items (null, number, missing-label object) are filtered; context does not carry them", async () => {
  // Seed a nav array that is as broken as a direct DB write can produce:
  // null (would throw 'Cannot read properties of null'), a bare number,
  // and an object that has href but no label (would render undefined label text).
  await setSetting(
    db,
    "site.nav",
    [null, 42, { href: "/no-label" }],
    "public",
  );
  const ctx = await buildRenderContext(db, { kind: "home" });
  // None of the malformed items should survive the per-item filter.
  expect(ctx.site.nav).toHaveLength(0);
  // Every surviving item (when the DB has valid items) must have string fields.
  await setSetting(
    db,
    "site.nav",
    [
      null,
      42,
      { href: "/no-label" },
      { label: "Blog", href: "/blog" }, // one valid item mixed in
    ],
    "public",
  );
  const ctx2 = await buildRenderContext(db, { kind: "home" });
  expect(ctx2.site.nav).toHaveLength(1);
  expect(ctx2.site.nav[0]).toEqual({ label: "Blog", href: "/blog" });
});

// ── Issue 053 defect — a nav item for a DISABLED module must not render ───────
// A saved site.nav item pointing at a module's public route becomes a dead link
// the moment that module is disabled (its route 404s). The public masthead must
// reflect current module state: buildRenderContext drops such items when the
// caller supplies the disabled modules' nav bases.

test("053 defect — nav items targeting a disabled module's route are filtered from the rendered nav; present again when enabled", async () => {
  await setSetting(
    db,
    "site.nav",
    [
      { label: "Photos", href: "/photos" }, // photos module route
      { label: "Blog", href: "/blog" }, // blog module route
      { label: "About", href: "/pages/about" }, // core page — never a module route
      { label: "Elsewhere", href: "https://example.com" }, // external — never filtered
    ],
    "public",
  );

  // Photos disabled → its base "/photos" is passed in; the Photos item is dropped,
  // everything else (blog, core page, external) survives.
  const disabled = await buildRenderContext(db, { kind: "home" }, {
    disabledModuleNavBases: ["/photos"],
  });
  expect(disabled.site.nav.map((n) => n.href)).toEqual([
    "/blog",
    "/pages/about",
    "https://example.com",
  ]);

  // Re-enabled (no disabled bases) → the Photos link is back.
  const enabled = await buildRenderContext(db, { kind: "home" }, {
    disabledModuleNavBases: [],
  });
  expect(enabled.site.nav.map((n) => n.href)).toContain("/photos");

  // A deeper link under the disabled base (e.g. a hand-added /photos/foo) is also
  // filtered; a look-alike sibling (/photobooth) is NOT.
  await setSetting(
    db,
    "site.nav",
    [
      { label: "A photo", href: "/photos/sunset" },
      { label: "Photobooth", href: "/photobooth" },
    ],
    "public",
  );
  const deep = await buildRenderContext(db, { kind: "home" }, {
    disabledModuleNavBases: ["/photos"],
  });
  expect(deep.site.nav.map((n) => n.href)).toEqual(["/photobooth"]);
});

// ── Issue 020 regression — site.social uses the REAL client shape ({network,
// href}), not the site.nav shape ({label, href}). buildSiteIdentity()'s social
// filter previously checked only `href`, not `network` — an object missing
// `network` (as broken a DB write as site.nav's null/number/missing-field
// cases above) silently survived the filter and would have rendered as a
// social link with an undefined network label. This test encodes the real
// client contract (SocialItem in SettingsForm.tsx / SiteIdentity["social"] in
// theme/types.ts), not the bug.

test("issue 020 — malformed site.social items (null, number, missing-network object) are filtered; valid {network,href} items survive", async () => {
  await setSetting(
    db,
    "site.social",
    [null, 42, { href: "/no-network" }],
    "public",
  );
  const ctx = await buildRenderContext(db, { kind: "home" });
  // None of the malformed items should survive the per-item filter.
  expect(ctx.site.social).toHaveLength(0);

  await setSetting(
    db,
    "site.social",
    [
      null,
      42,
      { href: "/no-network" },
      { network: "Mastodon", href: "https://mastodon.social/@owner" }, // one valid item mixed in
    ],
    "public",
  );
  const ctx2 = await buildRenderContext(db, { kind: "home" });
  expect(ctx2.site.social).toHaveLength(1);
  expect(ctx2.site.social[0]).toEqual({
    network: "Mastodon",
    href: "https://mastodon.social/@owner",
  });
});

// ── Photo-post canonical URL ────────────────────────────────────────────────

test("photo-post canonical URL is /photos/<slug>, not /blog/<slug>", async () => {
  const savedOrigin = process.env.OSSHP_ORIGIN;
  process.env.OSSHP_ORIGIN = "https://test.example.com";
  try {
    const ctx = await buildRenderContext(db, {
      kind: "photo-post",
      slug: "alpine-morning",
    });
    // photo-post canonical must point to /photos, never /blog.
    expect(ctx.route.canonicalUrl).toBe(
      "https://test.example.com/photos/alpine-morning",
    );
    expect(ctx.route.canonicalUrl).not.toContain("/blog/");
  } finally {
    process.env.OSSHP_ORIGIN = savedOrigin;
  }
});

// ── Blog listing excludes photo-posts by default ────────────────────────────

test("post-list context excludes photo-posts with showInBlog=false", async () => {
  await createPost(db, {
    title: "Article One",
    slug: "article-one",
    body: "content",
    type: "article",
    status: "published",
  });
  await createPost(db, {
    title: "Sunset Photo",
    slug: "sunset-photo",
    body: "content",
    type: "photo-post",
    status: "published",
    showInBlog: false,
  });

  const ctx = await buildRenderContext(db, { kind: "post-list" });
  if (ctx.content.kind !== "post-list") throw new Error("expected post-list");
  const titles = ctx.content.posts.map((p) => p.title);
  expect(titles).toContain("Article One");
  expect(titles).not.toContain("Sunset Photo");
});

test("post-list context includes photo-post with showInBlog=true", async () => {
  await createPost(db, {
    title: "Article One",
    slug: "article-one",
    body: "content",
    type: "article",
    status: "published",
  });
  await createPost(db, {
    title: "Opted-In Photo",
    slug: "opted-in-photo",
    body: "content",
    type: "photo-post",
    status: "published",
    showInBlog: true,
  });

  const ctx = await buildRenderContext(db, { kind: "post-list" });
  if (ctx.content.kind !== "post-list") throw new Error("expected post-list");
  const titles = ctx.content.posts.map((p) => p.title);
  expect(titles).toContain("Article One");
  expect(titles).toContain("Opted-In Photo");
});

// ── Photo-list (photos grid) still shows ALL photo-posts ────────────────────

test("photo-list context shows ALL photo-posts regardless of showInBlog", async () => {
  await createPost(db, {
    title: "Photo Off",
    slug: "photo-off",
    body: "content",
    type: "photo-post",
    status: "published",
    showInBlog: false,
  });
  await createPost(db, {
    title: "Photo On",
    slug: "photo-on",
    body: "content",
    type: "photo-post",
    status: "published",
    showInBlog: true,
  });

  const ctx = await buildRenderContext(db, { kind: "photo-list" });
  if (ctx.content.kind !== "photo-list") throw new Error("expected photo-list");
  const titles = ctx.content.posts.map((p) => p.title);
  expect(titles).toContain("Photo Off");
  expect(titles).toContain("Photo On");
});

// ── V-010 — page-nav merge ───────────────────────────────────────────────────

test("V-010 — published page with showInNav=true is merged into site.nav", async () => {
  await createPage(db, {
    title: "About",
    slug: "about",
    body: "hello",
    status: "published",
    showInNav: true,
  });
  const ctx = await buildRenderContext(db, { kind: "home" });
  const hrefs = ctx.site.nav.map((n) => n.href);
  expect(hrefs).toContain("/pages/about");
  const labels = ctx.site.nav.map((n) => n.label);
  expect(labels).toContain("About");
});

test("V-010 — draft page with showInNav=true is NOT merged into site.nav", async () => {
  await createPage(db, {
    title: "Hidden Draft",
    slug: "hidden-draft",
    body: "secret",
    status: "draft",
    showInNav: true,
  });
  const ctx = await buildRenderContext(db, { kind: "home" });
  const hrefs = ctx.site.nav.map((n) => n.href);
  expect(hrefs).not.toContain("/pages/hidden-draft");
});

test("V-010 — published page with showInNav=false is NOT merged into site.nav", async () => {
  await createPage(db, {
    title: "Off Nav",
    slug: "off-nav",
    body: "content",
    status: "published",
    showInNav: false,
  });
  const ctx = await buildRenderContext(db, { kind: "home" });
  const hrefs = ctx.site.nav.map((n) => n.href);
  expect(hrefs).not.toContain("/pages/off-nav");
});

test("V-010 — page-nav item is NOT duplicated if Settings nav already has its /pages/<slug> URL", async () => {
  // Operator manually added the same page's URL to Settings nav
  await setSetting(
    db,
    "site.nav",
    [{ label: "Custom About", href: "/pages/about" }],
    "public",
  );
  await createPage(db, {
    title: "About",
    slug: "about",
    body: "hello",
    status: "published",
    showInNav: true,
  });
  const ctx = await buildRenderContext(db, { kind: "home" });
  const hrefs = ctx.site.nav.map((n) => n.href);
  // Should appear exactly once.
  expect(hrefs.filter((h) => h === "/pages/about")).toHaveLength(1);
});

test("V-010 — page-list route resolves to page-list content", async () => {
  await createPage(db, {
    title: "Portfolio",
    slug: "portfolio",
    body: "Work",
    status: "published",
  });
  await createPage(db, {
    title: "Draft Page",
    slug: "draft-page",
    body: "hidden",
    status: "draft",
  });
  const ctx = await buildRenderContext(db, { kind: "page-list" });
  if (ctx.content.kind !== "page-list") throw new Error("expected page-list content");
  const titles = ctx.content.pages.map((p) => p.title);
  expect(titles).toContain("Portfolio");
  expect(titles).not.toContain("Draft Page");
  expect(ctx.route.kind).toBe("page-list");
});

test("issue 061 — tag-list route resolves to tag-list content, with counts, excluding draft-only tags", async () => {
  await createPost(db, {
    title: "Post A",
    slug: "post-a",
    body: "x",
    status: "published",
    publishDate: "2026-06-01T00:00:00.000Z",
    tags: [{ name: "Docker", slug: "docker" }],
  });
  await createPost(db, {
    title: "Post B",
    slug: "post-b",
    body: "x",
    status: "published",
    publishDate: "2026-06-02T00:00:00.000Z",
    tags: [{ name: "Docker", slug: "docker" }],
  });
  await createPost(db, {
    title: "Draft-only tag",
    slug: "draft-tagged",
    body: "x",
    status: "draft",
    tags: [{ name: "Hidden", slug: "hidden" }],
  });

  const ctx = await buildRenderContext(db, { kind: "tag-list" });
  if (ctx.content.kind !== "tag-list") throw new Error("expected tag-list content");
  expect(ctx.content.tags).toEqual([{ name: "Docker", slug: "docker", count: 2 }]);
  expect(ctx.route.kind).toBe("tag-list");
  // canonicalUrl is OSSHP_ORIGIN + "/tags" — assert the path suffix rather than
  // a bare "/tags" (the test env sets a default OSSHP_ORIGIN; see the
  // save/set/restore pattern other canonical-URL tests in this file use).
  expect(ctx.route.canonicalUrl.endsWith("/tags")).toBe(true);
});

test("issue 061 — tag-list route with zero tags resolves to an empty (not missing/found:false) list", async () => {
  const ctx = await buildRenderContext(db, { kind: "tag-list" });
  if (ctx.content.kind !== "tag-list") throw new Error("expected tag-list content");
  expect(ctx.content.tags).toEqual([]);
  // Matches page-list's precedent: an empty listing is still a valid 200 page
  // (the theme renders an empty-state message), not a 404.
  expect(ctx.route.kind).toBe("tag-list");
});

test("D1 — malformed site.nav renders the home page without throwing (public site stays 200)", async () => {
  await setSetting(
    db,
    "site.nav",
    [null, 42, { href: "/no-label" }],
    "public",
  );
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { renderRequest } = await import("@/lib/theme");
  const { editorialTheme } = await import("@/themes/editorial/theme");
  // A malformed nav must not cause renderRequest to throw or renderToStaticMarkup
  // to throw — the filter keeps only valid items, so the theme's .map() sees [].
  const node = await renderRequest(db, editorialTheme, { kind: "home" });
  expect(() => renderToStaticMarkup(node)).not.toThrow();
});

// ── Issue 012 — home featured showcase + intro ──────────────────────────────

function summary(
  slug: string,
  publishedAt: string,
  type: "article" | "photo-post" = "article",
): PublicPostSummary {
  return {
    title: slug,
    slug,
    excerpt: "",
    coverImage: null,
    publishedAt,
    readingLength: 1,
    galleryCount: 0,    panoramic: false,
    type,
    tags: [],
  };
}

describe("selectFeatured (pure) — cap + rotation semantics", () => {
  const all = Array.from({ length: 7 }, (_, i) =>
    // newest-first: index 0 is the newest
    summary(`f${i}`, `2026-07-${String(20 - i).padStart(2, "0")}T00:00:00.000Z`),
  );

  test("returns the whole set unchanged when at or below the cap", () => {
    const four = all.slice(0, FEATURED_CAP);
    expect(selectFeatured(four)).toEqual(four);
    expect(selectFeatured(all.slice(0, 1))).toHaveLength(1);
  });

  test("caps at FEATURED_CAP when over-featured", () => {
    expect(selectFeatured(all)).toHaveLength(FEATURED_CAP);
  });

  test("the selected subset is always drawn from the featured set", () => {
    const slugs = new Set(all.map((p) => p.slug));
    // Run several times to exercise different random draws.
    for (let n = 0; n < 20; n++) {
      for (const p of selectFeatured(all)) expect(slugs.has(p.slug)).toBe(true);
    }
  });

  test("the selection is sorted newest-first (lead is the newest chosen)", () => {
    // Deterministic rng that picks a specific window, then assert ordering.
    const picked = selectFeatured(all, FEATURED_CAP, () => 0.5);
    for (let i = 1; i < picked.length; i++) {
      expect(picked[i - 1].publishedAt >= picked[i].publishedAt).toBe(true);
    }
  });
});

describe("home context — featured + intro (issue 012)", () => {
  test("featured showcase carries only featured published posts of any type, newest-first", async () => {
    await createPost(db, { title: "Feat Article", slug: "fa", body: "x", status: "published", featured: true, publishDate: "2026-05-01T00:00:00.000Z" });
    await createPost(db, { title: "Feat Photo", slug: "fp", body: "", type: "photo-post", status: "published", featured: true, publishDate: "2026-06-01T00:00:00.000Z" });
    await createPost(db, { title: "Plain Article", slug: "pa", body: "x", status: "published", featured: false, publishDate: "2026-04-01T00:00:00.000Z" });

    const ctx = await buildRenderContext(db, { kind: "home" });
    if (ctx.content.kind !== "home") throw new Error("expected home content");
    const slugs = ctx.content.featured.map((p) => p.slug);
    expect(slugs).toEqual(["fp", "fa"]); // newest-first; plain excluded
    expect(ctx.content.featuredTotal).toBe(2);
  });

  test("a featured photo-post appears in the showcase even when not shown in the blog stream", async () => {
    await createPost(db, { title: "Photo Only", slug: "po", body: "", type: "photo-post", status: "published", featured: true, showInBlog: false, publishDate: "2026-06-01T00:00:00.000Z" });
    const ctx = await buildRenderContext(db, { kind: "home" });
    if (ctx.content.kind !== "home") throw new Error("expected home content");
    expect(ctx.content.featured.map((p) => p.slug)).toContain("po");
    // …and it is NOT in the blog-stream ledger (show_in_blog=false).
    expect(ctx.content.posts.map((p) => p.slug)).not.toContain("po");
  });

  test("home.intro is null when unset (deck omitted), and passes through when set", async () => {
    const bare = await buildRenderContext(db, { kind: "home" });
    if (bare.content.kind !== "home") throw new Error("expected home content");
    expect(bare.content.intro).toBeNull();

    await setSetting(db, "home.intro", "  Hello there.  ", "public");
    const withIntro = await buildRenderContext(db, { kind: "home" });
    if (withIntro.content.kind !== "home") throw new Error("expected home content");
    expect(withIntro.content.intro).toBe("  Hello there.  ");

    // Blank/whitespace-only intro is treated as unset (null → deck omitted).
    await setSetting(db, "home.intro", "   ", "public");
    const blank = await buildRenderContext(db, { kind: "home" });
    if (blank.content.kind !== "home") throw new Error("expected home content");
    expect(blank.content.intro).toBeNull();
  });
});

describe("home context — filtered to enabled modules (issue 028)", () => {
  test("disabling a module removes its content from the featured showcase and the recent ledger; re-enabling restores it", async () => {
    await createPost(db, {
      title: "Blog Post",
      slug: "blog-post",
      body: "x",
      type: "article",
      status: "published",
      featured: true,
      publishDate: "2026-06-01T00:00:00.000Z",
    });
    await createPost(db, {
      title: "Photo Post",
      slug: "photo-post",
      body: "",
      type: "photo-post",
      status: "published",
      featured: true,
      showInBlog: true, // also in the blog-stream ledger
      publishDate: "2026-06-02T00:00:00.000Z",
    });

    // Both modules enabled: both posts appear in the showcase and the ledger.
    const bothEnabled = await buildRenderContext(db, { kind: "home" }, {
      enabledModuleIds: ["blog", "photos"],
    });
    if (bothEnabled.content.kind !== "home") throw new Error("expected home content");
    expect(bothEnabled.content.featured.map((p) => p.slug).sort()).toEqual(["blog-post", "photo-post"]);
    expect(bothEnabled.content.posts.map((p) => p.slug).sort()).toEqual(["blog-post", "photo-post"]);

    // Photos disabled: the photo-post disappears from both the showcase and
    // the ledger — no dead link to the now-404ing /photos/photo-post route.
    const photosDisabled = await buildRenderContext(db, { kind: "home" }, {
      enabledModuleIds: ["blog"],
    });
    if (photosDisabled.content.kind !== "home") throw new Error("expected home content");
    expect(photosDisabled.content.featured.map((p) => p.slug)).toEqual(["blog-post"]);
    expect(photosDisabled.content.featuredTotal).toBe(1);
    expect(photosDisabled.content.posts.map((p) => p.slug)).toEqual(["blog-post"]);

    // Blog disabled instead: the article disappears; the photo-post remains.
    const blogDisabled = await buildRenderContext(db, { kind: "home" }, {
      enabledModuleIds: ["photos"],
    });
    if (blogDisabled.content.kind !== "home") throw new Error("expected home content");
    expect(blogDisabled.content.featured.map((p) => p.slug)).toEqual(["photo-post"]);
    expect(blogDisabled.content.posts.map((p) => p.slug)).toEqual(["photo-post"]);

    // Re-enabling both restores full visibility.
    const restored = await buildRenderContext(db, { kind: "home" }, {
      enabledModuleIds: ["blog", "photos"],
    });
    if (restored.content.kind !== "home") throw new Error("expected home content");
    expect(restored.content.featured.map((p) => p.slug).sort()).toEqual(["blog-post", "photo-post"]);
    expect(restored.content.posts.map((p) => p.slug).sort()).toEqual(["blog-post", "photo-post"]);
  });

  test("omitting enabledModuleIds does not filter anything (back-compat default)", async () => {
    await createPost(db, { title: "P", slug: "p", body: "", type: "photo-post", status: "published", featured: true, showInBlog: true, publishDate: "2026-06-01T00:00:00.000Z" });
    const ctx = await buildRenderContext(db, { kind: "home" });
    if (ctx.content.kind !== "home") throw new Error("expected home content");
    expect(ctx.content.featured.map((p) => p.slug)).toEqual(["p"]);
    expect(ctx.content.posts.map((p) => p.slug)).toEqual(["p"]);
  });
});

// ── Issue 074 — disabled-module content leaking into /blog, /tags/<slug>,
// and the /tags index (unfixed on these three surfaces by issue 028) ────────

describe("post-list context — filtered to enabled modules (issue 074)", () => {
  test("a photo-post opted into the blog stream disappears when Photos is disabled; re-enabling restores it", async () => {
    await createPost(db, {
      title: "Blog Post",
      slug: "blog-post",
      body: "x",
      type: "article",
      status: "published",
    });
    await createPost(db, {
      title: "Opted-In Photo",
      slug: "opted-in-photo",
      body: "",
      type: "photo-post",
      status: "published",
      showInBlog: true,
    });

    const bothEnabled = await buildRenderContext(db, { kind: "post-list" }, {
      enabledModuleIds: ["blog", "photos"],
    });
    if (bothEnabled.content.kind !== "post-list") throw new Error("expected post-list content");
    expect(bothEnabled.content.posts.map((p) => p.slug).sort()).toEqual(["blog-post", "opted-in-photo"]);

    const photosDisabled = await buildRenderContext(db, { kind: "post-list" }, {
      enabledModuleIds: ["blog"],
    });
    if (photosDisabled.content.kind !== "post-list") throw new Error("expected post-list content");
    expect(photosDisabled.content.posts.map((p) => p.slug)).toEqual(["blog-post"]);

    const restored = await buildRenderContext(db, { kind: "post-list" }, {
      enabledModuleIds: ["blog", "photos"],
    });
    if (restored.content.kind !== "post-list") throw new Error("expected post-list content");
    expect(restored.content.posts.map((p) => p.slug).sort()).toEqual(["blog-post", "opted-in-photo"]);
  });

  test("omitting enabledModuleIds does not filter anything (back-compat default — issue 074 AC5)", async () => {
    await createPost(db, { title: "Article One", slug: "article-one", body: "content", type: "article", status: "published" });
    await createPost(db, { title: "Opted-In Photo", slug: "opted-in-photo", body: "content", type: "photo-post", status: "published", showInBlog: true });
    const ctx = await buildRenderContext(db, { kind: "post-list" });
    if (ctx.content.kind !== "post-list") throw new Error("expected post-list content");
    const titles = ctx.content.posts.map((p) => p.title);
    expect(titles).toContain("Article One");
    expect(titles).toContain("Opted-In Photo");
  });
});

describe("tag context — filtered to enabled modules (issue 074)", () => {
  test("a photo-post tagged and belonging to a disabled module does not appear on /tags/<slug>; re-enabling restores it", async () => {
    await createPost(db, {
      title: "Blog Post",
      slug: "blog-post",
      body: "x",
      type: "article",
      status: "published",
      tags: [{ name: "Travel", slug: "travel" }],
    });
    await createPost(db, {
      title: "Photo Post",
      slug: "photo-post",
      body: "",
      type: "photo-post",
      status: "published",
      tags: [{ name: "Travel", slug: "travel" }],
    });

    const bothEnabled = await buildRenderContext(db, { kind: "tag", slug: "travel" }, {
      enabledModuleIds: ["blog", "photos"],
    });
    if (bothEnabled.content.kind !== "tag") throw new Error("expected tag content");
    expect(bothEnabled.content.posts.map((p) => p.slug).sort()).toEqual(["blog-post", "photo-post"]);
    expect(bothEnabled.content.tag.slug).toBe("travel");

    const photosDisabled = await buildRenderContext(db, { kind: "tag", slug: "travel" }, {
      enabledModuleIds: ["blog"],
    });
    if (photosDisabled.content.kind !== "tag") throw new Error("expected tag content");
    expect(photosDisabled.content.posts.map((p) => p.slug)).toEqual(["blog-post"]);
    // The tag header itself still resolves (derived from the unfiltered set).
    expect(photosDisabled.content.tag.slug).toBe("travel");

    const restored = await buildRenderContext(db, { kind: "tag", slug: "travel" }, {
      enabledModuleIds: ["blog", "photos"],
    });
    if (restored.content.kind !== "tag") throw new Error("expected tag content");
    expect(restored.content.posts.map((p) => p.slug).sort()).toEqual(["blog-post", "photo-post"]);
  });

  test("a tag whose ONLY post belongs to a disabled module resolves with an empty post list, not a fallback slug-only tag", async () => {
    await createPost(db, {
      title: "Photo Post",
      slug: "photo-post-solo",
      body: "",
      type: "photo-post",
      status: "published",
      tags: [{ name: "Sunsets", slug: "sunsets" }],
    });
    const ctx = await buildRenderContext(db, { kind: "tag", slug: "sunsets" }, {
      enabledModuleIds: ["blog"],
    });
    if (ctx.content.kind !== "tag") throw new Error("expected tag content");
    expect(ctx.content.posts).toEqual([]);
    expect(ctx.content.tag).toEqual({ name: "Sunsets", slug: "sunsets" });
  });

  test("omitting enabledModuleIds does not filter anything (back-compat default)", async () => {
    await createPost(db, {
      title: "Photo Post",
      slug: "photo-post",
      body: "",
      type: "photo-post",
      status: "published",
      tags: [{ name: "Travel", slug: "travel" }],
    });
    const ctx = await buildRenderContext(db, { kind: "tag", slug: "travel" });
    if (ctx.content.kind !== "tag") throw new Error("expected tag content");
    expect(ctx.content.posts.map((p) => p.slug)).toEqual(["photo-post"]);
  });
});

describe("tag-list context — filtered to enabled modules (issue 074)", () => {
  test("a tag whose only visible post belongs to a disabled module is absent from the /tags index; re-enabling restores it with the correct count", async () => {
    await createPost(db, {
      title: "Blog Post",
      slug: "blog-post",
      body: "x",
      type: "article",
      status: "published",
      tags: [{ name: "Docker", slug: "docker" }],
    });
    await createPost(db, {
      title: "Photo Post",
      slug: "photo-post",
      body: "",
      type: "photo-post",
      status: "published",
      tags: [{ name: "Sunsets", slug: "sunsets" }],
    });

    const bothEnabled = await buildRenderContext(db, { kind: "tag-list" }, {
      enabledModuleIds: ["blog", "photos"],
    });
    if (bothEnabled.content.kind !== "tag-list") throw new Error("expected tag-list content");
    expect(bothEnabled.content.tags).toEqual([
      { name: "Docker", slug: "docker", count: 1 },
      { name: "Sunsets", slug: "sunsets", count: 1 },
    ]);

    const photosDisabled = await buildRenderContext(db, { kind: "tag-list" }, {
      enabledModuleIds: ["blog"],
    });
    if (photosDisabled.content.kind !== "tag-list") throw new Error("expected tag-list content");
    // "Sunsets" is dropped entirely — its only post belongs to the disabled
    // Photos module — not shown with a stale non-zero count.
    expect(photosDisabled.content.tags).toEqual([{ name: "Docker", slug: "docker", count: 1 }]);

    const restored = await buildRenderContext(db, { kind: "tag-list" }, {
      enabledModuleIds: ["blog", "photos"],
    });
    if (restored.content.kind !== "tag-list") throw new Error("expected tag-list content");
    expect(restored.content.tags).toEqual([
      { name: "Docker", slug: "docker", count: 1 },
      { name: "Sunsets", slug: "sunsets", count: 1 },
    ]);
  });

  test("omitting enabledModuleIds does not filter anything (back-compat default)", async () => {
    await createPost(db, {
      title: "Post A",
      slug: "post-a",
      body: "x",
      status: "published",
      publishDate: "2026-06-01T00:00:00.000Z",
      tags: [{ name: "Docker", slug: "docker" }],
    });
    const ctx = await buildRenderContext(db, { kind: "tag-list" });
    if (ctx.content.kind !== "tag-list") throw new Error("expected tag-list content");
    expect(ctx.content.tags).toEqual([{ name: "Docker", slug: "docker", count: 1 }]);
  });
});
