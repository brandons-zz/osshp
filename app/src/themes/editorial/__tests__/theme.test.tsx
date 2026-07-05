// Intent-level tests for the Editorial Clarity reference theme (M1.9). These
// encode the acceptance criteria, not incidental markup: required render targets
// exist, the document shell is contract-correct, the sticky header + visitor
// toggle are present (issue 003 + the only public chrome control), head.meta is
// rendered (§8.2 rule 2), BOTH schemes render, the demo-harness chrome from the
// prototype does NOT ship, and the templates emit no raw hex (semantic tokens
// only). A regression on any of these would fail a meaningful business rule.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { validateManifest, renderPage } from "@/lib/theme/engine";
import { emptySlots } from "@/lib/theme/registry";
import type {
  DocumentShell,
  SanitizedHtml,
  SanitizedSlotOutput,
  Scheme,
  ThemeContent,
  ThemeRenderContext,
} from "@/lib/theme/types";
import { editorialTheme } from "../theme";

const sani = (s: string) => s as unknown as SanitizedHtml;

function mockCtx(
  content: ThemeContent,
  scheme: Scheme = "light",
  slotOverrides: Partial<Record<string, SanitizedSlotOutput[]>> = {},
): ThemeRenderContext {
  const slots = emptySlots();
  for (const [k, v] of Object.entries(slotOverrides)) {
    (slots as Record<string, SanitizedSlotOutput[]>)[k] = v!;
  }
  return {
    site: {
      title: "Alex Rivera",
      description: "Notes on Docker, Linux, and the homelab.",
      nav: [
        { label: "Writing", href: "/blog" },
        { label: "About", href: "/pages/about" },
      ],
      social: [{ network: "bluesky", href: "https://bsky.app/x" }],
      logo: null,
      defaultScheme: "light",
      locale: "en",
    },
    route: { kind: content.kind === "photo-post" ? "post" : (content.kind as ThemeRenderContext["route"]["kind"]), canonicalUrl: "https://example.com/" },
    content,
    brand: {
      accentSolid: "var(--accent-solid)",
      accentText: "var(--accent-text)",
      onAccent: "var(--on-accent)",
      fontHeading: "system-ui",
      fontBody: "system-ui",
      fontMono: "monospace",
    },
    scheme,
    slots,
    helpers: {
      assetUrl: (k) => `/media/${k}`,
      formatDate: (iso) => iso.slice(0, 10),
      excerpt: (h, n) => h.slice(0, n),
    },
  };
}

const SHELL = (scheme: Scheme): Pick<DocumentShell, "brandTokenCss"> & {
  scheme: Scheme;
} => ({ scheme, brandTokenCss: ":root{--accent-solid:#2F5FE0}" });

function renderFull(ctx: ThemeRenderContext): string {
  return renderToStaticMarkup(
    renderPage(editorialTheme, ctx, { brandTokenCss: SHELL(ctx.scheme).brandTokenCss }),
  );
}

const POST: ThemeContent = {
  kind: "post",
  post: {
    title: "A Docker Compose stack you can actually move",
    slug: "portable-compose",
    bodyHtml: sani("<p>Portability is a design choice.</p><blockquote>quote</blockquote>"),
    gallery: [],    excerpt: "Portability is a design choice.",
    coverImage: null,
    type: "article",
    panoramic: false,
    publishedAt: "2026-06-11T00:00:00.000Z",
    tags: [{ name: "Docker", slug: "docker" }],
  },
};

const HOME: ThemeContent = {
  kind: "home",
  posts: [
    {
      title: "Hardening a NAS",
      slug: "nas",
      excerpt: "A pragmatic baseline.",
      coverImage: null,
      publishedAt: "2026-06-24T00:00:00.000Z",
      readingLength: 4,
      galleryCount: 0,      panoramic: false,
      type: "article",
      tags: [{ name: "Security", slug: "security" }],
    },
  ],
  featured: [],
  featuredTotal: 0,
  intro: null,
};

// A home fixture with a full showcase: a lead essay (with cover), a supporting
// photo-post (with cover), and a supporting essay with NO cover (typographic
// plate). Total 5 featured while showing 3 → the rotation register ghost.
const HOME_FEATURED: ThemeContent = {
  kind: "home",
  intro: "I build quiet infrastructure and photograph the walks in between.",
  featuredTotal: 5,
  featured: [
    {
      title: "What the snowmelt remembers",
      slug: "snowmelt",
      excerpt: "On the hydrology of a small valley and capacity planning.",
      coverImage: { src: "/media/snow/800.jpg", alt: "A snow-covered ridge" },
      publishedAt: "2026-05-12T00:00:00.000Z",
      readingLength: 11,
      galleryCount: 0,      panoramic: false,
      type: "article",
      tags: [],
    },
    {
      title: "Meltwater, Sarek",
      slug: "meltwater",
      excerpt: "",
      coverImage: { src: "/media/melt/800.jpg", alt: "Braided meltwater" },
      publishedAt: "2026-04-02T00:00:00.000Z",
      readingLength: 1,
      galleryCount: 0,      panoramic: false,
      type: "photo-post",
      tags: [],
    },
    {
      title: "Backups you have actually restored",
      slug: "backups",
      excerpt: "A short discipline.",
      coverImage: null,
      publishedAt: "2026-03-18T00:00:00.000Z",
      readingLength: 6,
      galleryCount: 0,      panoramic: false,
      type: "article",
      tags: [],
    },
  ],
  posts: [
    {
      title: "Hardening a NAS",
      slug: "nas",
      excerpt: "A pragmatic baseline.",
      coverImage: null,
      publishedAt: "2026-06-24T00:00:00.000Z",
      readingLength: 4,
      galleryCount: 0,      panoramic: false,
      type: "article",
      tags: [{ name: "Security", slug: "security" }],
    },
  ],
};

describe("reference theme implements the theme contract", () => {
  test("manifest is valid: document + all required content targets present", () => {
    expect(() => validateManifest(editorialTheme)).not.toThrow();
    expect(editorialTheme.id).toBe("editorial");
    for (const t of ["home", "post", "page", "post-list"] as const) {
      expect(typeof editorialTheme.templates[t]).toBe("function");
    }
    // optional targets also provided for fidelity
    expect(typeof editorialTheme.templates.tag).toBe("function");
    expect(typeof editorialTheme.templates["not-found"]).toBe("function");
    expect(editorialTheme.schemes).toEqual(["light", "dark"]);
  });

  test("both schemes render and set data-scheme on <html>", () => {
    expect(renderFull(mockCtx(HOME, "light"))).toContain('data-scheme="light"');
    expect(renderFull(mockCtx(HOME, "dark"))).toContain('data-scheme="dark"');
  });

  test("head.meta slot output is rendered (§8.2 rule 2)", () => {
    const html = renderFull(
      mockCtx(HOME, "light", {
        "head.meta": [
          { sourceModuleId: "seo", order: 0, html: sani('<meta name="og:type" content="website">') },
        ],
      }),
    );
    expect(html).toContain('name="og:type"');
  });

  test("templates emit no raw hex color in inline styles (semantic tokens only)", () => {
    // The theme's own markup carries no style="" with a hex; the only hex in the
    // document is the app-injected brandTokenCss <style> block (not the theme's).
    const html = renderFull(mockCtx(POST, "light"));
    const styleAttrs = html.match(/style="[^"]*"/g) ?? [];
    for (const s of styleAttrs) {
      expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });

  test("post renders sanitized bodyHtml, title, byline, and tags", () => {
    const html = renderFull(mockCtx(POST, "light"));
    expect(html).toContain("A Docker Compose stack you can actually move");
    expect(html).toContain("Portability is a design choice.");
    expect(html).toContain("/tags/docker");
  });
});

// ── Issue 020 — site.social renders on the public footer ────────────────────
// mockCtx already carries a social item (bluesky), but nothing asserted the
// theme actually renders it — the footer only ever rendered site.nav. This
// test encodes the acceptance criterion end-to-end (context → theme markup).

describe("Issue 020 — social links render on the public footer", () => {
  test("a social item (network label + href) renders as a link in the footer", () => {
    const html = renderFull(mockCtx(HOME, "light"));
    expect(html).toContain('aria-label="Social"');
    expect(html).toContain('href="https://bsky.app/x"');
    expect(html).toContain(">bluesky<");
  });

  test("no social nav/landmark is emitted when site.social is empty", () => {
    const ctx = mockCtx(HOME, "light");
    ctx.site.social = [];
    const html = renderFull(ctx);
    expect(html).not.toContain('aria-label="Social"');
  });

  // Issue 038 — multiple social links render horizontally on one row, with an
  // aria-hidden "·" separator between adjacent items and none trailing.
  test("multiple social items render with an aria-hidden middot between adjacent links, none trailing", () => {
    const ctx = mockCtx(HOME, "light");
    ctx.site.social = [
      { network: "linkedin", href: "https://linkedin.com/in/x" },
      { network: "github", href: "https://github.com/x" },
      { network: "bluesky", href: "https://bsky.app/x" },
    ];
    const html = renderFull(ctx);
    const social = html.match(/<nav[^>]*aria-label="Social"[^>]*>[\s\S]*?<\/nav>/)?.[0];
    expect(social).toBeDefined();
    // Exactly 2 separators for 3 items — one between each adjacent pair, none
    // before the first or after the last.
    const seps = social!.match(/<span class="fsep" aria-hidden="true">·<\/span>/g) ?? [];
    expect(seps).toHaveLength(2);
    // The separator sits strictly between links, not leading/trailing the row.
    expect(social!.indexOf("linkedin") < social!.indexOf("·")).toBe(true);
    expect(social!.lastIndexOf("·") < social!.lastIndexOf("bluesky")).toBe(true);
    // Decorative only — no accessible name/role of its own.
    expect(social).toContain('aria-hidden="true"');
  });

  // Issue 060 — a social link left the visitor's tab entirely (no way back
  // without hitting the browser Back button). It must open in a NEW tab, and
  // per the security requirement that always accompanies target="_blank",
  // carry rel="noopener noreferrer" (blocks reverse-tabnabbing via
  // window.opener + suppresses the Referer header to the external site).
  test("issue 060 — a social link opens in a new tab with rel=noopener noreferrer", () => {
    const html = renderFull(mockCtx(HOME, "light"));
    expect(html).toContain(
      '<a href="https://bsky.app/x" target="_blank" rel="noopener noreferrer">bluesky</a>',
    );
  });

  test("issue 060 — internal nav links stay same-tab (no target attribute)", () => {
    const html = renderFull(mockCtx(HOME, "light"));
    // site.nav items (Writing, About) are internal — must NOT carry target="_blank".
    expect(html).toContain('<a href="/blog">Writing</a>');
    expect(html).not.toContain('<a href="/blog" target="_blank"');
  });
});

describe("CSP nonce-wiring (A1) — inline script/style carry the per-request nonce", () => {
  function renderWithNonce(nonce: string | undefined): string {
    return renderToStaticMarkup(
      renderPage(editorialTheme, mockCtx(HOME, "light"), {
        brandTokenCss: ":root{--accent-solid:#2F5FE0}",
        nonce,
      }),
    );
  }

  test("when a nonce is supplied, EVERY inline <script> and <style> carries it", () => {
    const html = renderWithNonce("test-nonce-123");
    // The brand <style> and both inline scripts (no-flash + visitor toggle) exist…
    expect(html).toContain('<style nonce="test-nonce-123"');
    expect(html).toContain('<script nonce="test-nonce-123"');
    // …and there is NO un-nonced inline <script> or <style> that CSP would block.
    expect(html).not.toMatch(/<script(?![^>]*\bnonce=)/);
    expect(html).not.toMatch(/<style(?![^>]*\bnonce=)/);
  });

  test("without a nonce (e.g. unit render), inline elements carry no nonce attribute", () => {
    const html = renderWithNonce(undefined);
    expect(html).not.toContain("nonce=");
    // the inline elements still render (visual unchanged) — just without a nonce
    expect(html).toContain("<style");
    expect(html).toContain("<script");
  });
});

// ── Additional content fixtures ──────────────────────────────────────────────

const POST_WITH_COVER: ThemeContent = {
  kind: "post",
  post: {
    title: "A Docker Compose stack you can actually move",
    slug: "portable-compose",
    bodyHtml: sani("<p>Portability is a design choice.</p>"),
    gallery: [],    excerpt: "Portability is a design choice.",
    coverImage: { src: "https://example.com/media/cover.jpg", alt: "Cover" },
    type: "article",
    panoramic: false,
    publishedAt: "2026-06-11T00:00:00.000Z",
    tags: [],
  },
};

const POST_LIST: ThemeContent = {
  kind: "post-list",
  posts: [],
};

const PAGE_CONTENT: ThemeContent = {
  kind: "page",
  page: {
    title: "About me",
    slug: "about",
    bodyHtml: sani("<p>I write about Docker.</p>"),
  },
};

// ── SEO / metadata tests (AC-1, AC-2 unit layer) ─────────────────────────────

describe("SEO — per-page titles are unique per page type (AC-1)", () => {
  test("home title is the site title only", () => {
    const html = renderFull(mockCtx(HOME, "light"));
    expect(html).toContain("<title>Alex Rivera</title>");
  });

  test("post title is 'post title — site title'", () => {
    const html = renderFull(mockCtx(POST, "light"));
    expect(html).toContain(
      "<title>A Docker Compose stack you can actually move — Alex Rivera</title>",
    );
  });

  test("post-list title is 'Writing — site title' (distinct from home)", () => {
    const html = renderFull(mockCtx(POST_LIST, "light"));
    expect(html).toContain("<title>Writing — Alex Rivera</title>");
    // Sanity: NOT the same as the home title.
    expect(html).not.toContain("<title>Alex Rivera</title>");
  });

  test("page title is 'page title — site title'", () => {
    const html = renderFull(mockCtx(PAGE_CONTENT, "light"));
    expect(html).toContain("<title>About me — Alex Rivera</title>");
  });
});

describe("SEO — per-page meta descriptions (AC-1)", () => {
  test("home uses site description", () => {
    const html = renderFull(mockCtx(HOME, "light"));
    expect(html).toContain(
      'name="description" content="Notes on Docker, Linux, and the homelab."',
    );
  });

  test("post uses post excerpt", () => {
    const html = renderFull(mockCtx(POST, "light"));
    expect(html).toContain(
      'name="description" content="Portability is a design choice."',
    );
  });
});

describe("SEO — canonical URL <link> present (AC-2)", () => {
  test("every page type has rel=canonical pointing at route.canonicalUrl", () => {
    const html = renderFull(mockCtx(HOME, "light"));
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('href="https://example.com/"');
  });
});

describe("SEO — Open Graph + Twitter Card tags on posts (AC-2)", () => {
  test("post emits og:title, og:description, og:type=article, og:url", () => {
    const html = renderFull(mockCtx(POST, "light"));
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('content="article"'); // og:type
    expect(html).toContain('property="og:url"');
    expect(html).toContain('content="https://example.com/"'); // canonical URL
  });

  test("home emits og:type=website", () => {
    const html = renderFull(mockCtx(HOME, "light"));
    expect(html).toContain('content="website"');
  });

  test("post with cover image emits og:image", () => {
    const ctx = mockCtx(POST_WITH_COVER, "light");
    (ctx.route as { canonicalUrl: string }).canonicalUrl =
      "https://example.com/blog/portable-compose";
    const html = renderFull(ctx);
    expect(html).toContain('property="og:image"');
    expect(html).toContain("https://example.com/media/cover.jpg");
  });

  test("post without cover image emits twitter:card=summary (not summary_large_image)", () => {
    const html = renderFull(mockCtx(POST, "light")); // POST has coverImage: null
    expect(html).toContain('name="twitter:card"');
    expect(html).toContain('content="summary"');
    expect(html).not.toContain("summary_large_image");
  });

  test("post with cover image emits twitter:card=summary_large_image", () => {
    const html = renderFull(mockCtx(POST_WITH_COVER, "light"));
    expect(html).toContain('content="summary_large_image"');
  });
});

describe("SEO — RSS autodiscovery link is module-gated, NOT hardcoded (fold-in fix)", () => {
  const RSS_LINK_PATTERN = /application\/rss\+xml/;

  test("with NO head.meta Blog contribution, head contains NO rss+xml link", () => {
    // Default mockCtx has empty slots — simulates Blog module disabled.
    const html = renderFull(mockCtx(HOME, "light"));
    expect(html).not.toMatch(RSS_LINK_PATTERN);
  });

  test("when Blog contributes RSS link to head.meta, it appears in <head>", () => {
    const html = renderFull(
      mockCtx(HOME, "light", {
        "head.meta": [
          {
            sourceModuleId: "blog",
            order: 0,
            html: sani(
              '<link rel="alternate" type="application/rss+xml" title="RSS feed" href="/rss.xml">',
            ),
          },
        ],
      }),
    );
    expect(html).toMatch(RSS_LINK_PATTERN);
    expect(html).toContain("/rss.xml");
  });
});

describe("Defect-2 regression — head.meta contributions use a head-valid wrapper (never <span>)", () => {
  // Note: renderFull calls renderPage directly (bypasses renderPublicRoute). In
  // production, renderPublicRoute injects head.meta as bare HTML before </head>
  // (no wrapper at all). In unit-test context the theme's HeadSlots component
  // is reached and uses <template> (valid metadata content in <head>). Both
  // paths are head-valid; neither uses <span> (which causes browser head-exit).

  const RSS_SLOT: SanitizedSlotOutput[] = [
    {
      sourceModuleId: "blog",
      order: 0,
      html: sani(
        '<link rel="alternate" type="application/rss+xml" title="RSS feed" href="/rss.xml">',
      ),
    },
  ];

  test("head.meta contribution is NOT wrapped in <span> (Defect-2 fix)", () => {
    const html = renderFull(mockCtx(HOME, "light", { "head.meta": RSS_SLOT }));
    // <span> is not valid inside <head> — the browser would exit head-parsing.
    // Any match here means the bug has regressed.
    expect(html).not.toMatch(/<span[^>]*><link[^>]*application\/rss\+xml/);
    expect(html).not.toMatch(/<span[^>]*>.*application\/rss\+xml/s);
  });

  test("head.meta RSS link appears before </head> in the served HTML", () => {
    const html = renderFull(mockCtx(HOME, "light", { "head.meta": RSS_SLOT }));
    const headEnd = html.indexOf("</head>");
    const rssIdx = html.indexOf("application/rss+xml");
    expect(rssIdx).not.toBe(-1); // link is present
    expect(headEnd).not.toBe(-1); // </head> is present
    expect(rssIdx).toBeLessThan(headEnd); // link precedes </head>
  });

  test("head.meta RSS link appears before <body> in the served HTML", () => {
    const html = renderFull(mockCtx(HOME, "light", { "head.meta": RSS_SLOT }));
    const bodyStart = html.indexOf("<body");
    const rssIdx = html.indexOf("application/rss+xml");
    expect(rssIdx).not.toBe(-1);
    expect(bodyStart).not.toBe(-1);
    expect(rssIdx).toBeLessThan(bodyStart);
  });
});

describe("sticky header + visitor toggle; no demo-harness chrome", () => {
  test("sticky header (issue 003): persistent header bar with brand + nav", () => {
    const html = renderFull(mockCtx(HOME, "light"));
    expect(html).toContain("site-head-bar"); // CSS makes this position:sticky
    expect(html).toContain("wordmark");
    expect(html).toContain('aria-label="Primary"'); // primary nav
    expect(html).toContain("/blog");
  });

  test("visitor light/dark toggle present with correct accessible state", () => {
    const light = renderFull(mockCtx(HOME, "light"));
    expect(light).toContain("data-scheme-toggle");
    expect(light).toContain('aria-label="Switch to dark theme"');
    const dark = renderFull(mockCtx(HOME, "dark"));
    expect(dark).toContain('aria-label="Switch to light theme"');
    // the toggle's persistence script ships inline
    expect(light).toContain("data-scheme-toggle");
    expect(light).toContain("localStorage.setItem");
  });

  test("NO prototype demo-harness chrome ships", () => {
    const html = renderFull(mockCtx(HOME, "light"));
    expect(html).not.toContain("data-set-accent"); // accent switcher
    expect(html).not.toContain("proto-bar");
    expect(html.toLowerCase()).not.toContain("reference theme");
    // accent-name demo buttons must not appear as chrome controls
    expect(html).not.toMatch(/aria-pressed[^>]*>\s*Teal/);
  });
});

// ── Issue 004 — back affordance + scroll restoration ─────────────────────────

const PHOTO_POST: ThemeContent = {
  kind: "photo-post",
  post: {
    title: "Sunset Over the Lake",
    slug: "sunset-lake",
    bodyHtml: sani("<p>Golden hour at the lake.</p>"),
    gallery: [],    excerpt: "Golden hour.",
    coverImage: { src: "/media/sunset/1200.jpg", alt: "Sunset over a calm lake" },
    type: "photo-post",
    panoramic: false,
    publishedAt: "2026-06-20T00:00:00.000Z",
    tags: [],
  },
};

const PHOTO_LIST: ThemeContent = {
  kind: "photo-list",
  posts: [
    {
      title: "Sunset Over the Lake",
      slug: "sunset-lake",
      excerpt: "Golden hour.",
      coverImage: { src: "/media/sunset/1200.jpg", alt: "Sunset over a calm lake" },
      publishedAt: "2026-06-20T00:00:00.000Z",
      readingLength: 1,
      galleryCount: 0,      panoramic: false,
      tags: [],
    },
  ],
};

describe("Issue 004 — back affordance (AC-1): in-content return link on item pages", () => {
  test("blog post back affordance is a 'backlink label' anchor pointing to /blog", () => {
    const html = renderFull(mockCtx(POST, "light"));
    // The .backlink.label element must be present and point to /blog.
    expect(html).toMatch(/class="backlink label"[^>]*href="\/blog"/);
    expect(html).toContain("← Writing");
  });

  test("photo-post back affordance is a 'backlink label' anchor pointing to /photos", () => {
    // content.kind="photo-post" is set by the /photos/[slug] route handler,
    // signalling that the originating listing is the Photographs grid.
    const html = renderFull(mockCtx(PHOTO_POST, "light"));
    // The .backlink.label element MUST point to /photos (not /blog).
    expect(html).toMatch(/class="backlink label"[^>]*href="\/photos"/);
    expect(html).toContain("← Photographs");
    // The backlink must NOT point to /blog on a photo-post page.
    expect(html).not.toMatch(/class="backlink label"[^>]*href="\/blog"/);
  });

  test("back affordance carries the 'label' class (monospace furniture, visible focus ring)", () => {
    const post = renderFull(mockCtx(POST, "light"));
    expect(post).toMatch(/class="backlink label"[^>]*href="\/blog"/);
    const photo = renderFull(mockCtx(PHOTO_POST, "light"));
    expect(photo).toMatch(/class="backlink label"[^>]*href="\/photos"/);
  });
});

describe("Issue 004 — scroll restore script (AC-2/3): listing pages only", () => {
  test("scroll restoration script is emitted on post-list pages", () => {
    const html = renderFull(mockCtx(POST_LIST, "light"));
    expect(html).toContain("osshp-scroll:");
    expect(html).toContain("scrollRestoration");
    expect(html).toContain("pagehide");
    expect(html).toContain("pageshow");
  });

  test("scroll restoration script is emitted on photo-list pages", () => {
    const html = renderFull(mockCtx(PHOTO_LIST, "light"));
    expect(html).toContain("osshp-scroll:");
    expect(html).toContain("scrollRestoration");
  });

  test("scroll restoration script is emitted on the home page (ledger is a listing)", () => {
    const html = renderFull(mockCtx(HOME, "light"));
    expect(html).toContain("osshp-scroll:");
  });

  test("scroll restoration script is NOT emitted on individual post or page routes", () => {
    // Post and page routes do not need to save/restore their own scroll; they
    // emit a back affordance that returns to the listing, where scroll IS saved.
    const postHtml = renderFull(mockCtx(POST, "light"));
    expect(postHtml).not.toContain("osshp-scroll:");

    const photoPostHtml = renderFull(mockCtx(PHOTO_POST, "light"));
    expect(photoPostHtml).not.toContain("osshp-scroll:");

    const pageHtml = renderFull(mockCtx(PAGE_CONTENT, "light"));
    expect(pageHtml).not.toContain("osshp-scroll:");
  });

  test("scroll restoration script carries the nonce when one is supplied (CSP-A1)", () => {
    const html = renderToStaticMarkup(
      renderPage(editorialTheme, mockCtx(POST_LIST, "light"), {
        brandTokenCss: ":root{--accent-solid:#2F5FE0}",
        nonce: "scroll-nonce-xyz",
      }),
    );
    // The script element that contains the scroll-restore logic must carry the nonce.
    expect(html).toMatch(/<script[^>]*nonce="scroll-nonce-xyz"[^>]*>[^<]*osshp-scroll:/);
  });

  test("photo grid tiles link to /photos/[slug] in the figcaption (navigation path to photo-item pages)", () => {
    const html = renderFull(mockCtx(PHOTO_LIST, "light"));
    // The figcaption must contain a link to the photo item page.
    expect(html).toContain('href="/photos/sunset-lake"');
    expect(html).toContain("Sunset Over the Lake");
    // The lightbox image anchor (href=image URL) must still be present for the
    // in-place preview; the title link is the navigation path.
    expect(html).toContain('class="glightbox"');
    expect(html).toContain("/media/sunset/1200.jpg");
  });
});

// ── V-010 — page-list template ───────────────────────────────────────────────

const PAGE_LIST: ThemeContent = {
  kind: "page-list",
  pages: [
    { title: "About Me", slug: "about" },
    { title: "Portfolio", slug: "portfolio" },
  ],
};

describe("V-010 — pages index (/pages) renders an on-identity listing", () => {
  test("page-list template renders all pages as linked entries", () => {
    const html = renderFull(mockCtx(PAGE_LIST, "light"));
    expect(html).toContain("About Me");
    expect(html).toContain('href="/pages/about"');
    expect(html).toContain("Portfolio");
    expect(html).toContain('href="/pages/portfolio"');
  });

  test("page-list title is 'Pages — site title'", () => {
    const html = renderFull(mockCtx(PAGE_LIST, "light"));
    expect(html).toContain("<title>Pages — Alex Rivera</title>");
  });

  test("page-list template renders a register header (§ Pages, consistent with other listing pages)", () => {
    const html = renderFull(mockCtx(PAGE_LIST, "light"));
    expect(html).toContain("Pages");
    // Uses the same .ledger-wrap layout as the writing index.
    expect(html).toContain("ledger-wrap");
  });

  test("page-list with no pages renders an empty message (not a crash)", () => {
    const emptyList: ThemeContent = { kind: "page-list", pages: [] };
    expect(() => renderFull(mockCtx(emptyList, "light"))).not.toThrow();
    const html = renderFull(mockCtx(emptyList, "light"));
    expect(html).toContain("No pages published yet.");
  });

  // Issue 059 — /pages rendered as VERTICAL/stacked titles instead of the
  // blog's horizontal rows, because a bespoke PageIndexItem emitted only the
  // `.mid` span with no `.no`/`.meta` siblings — a lone `.mid` child then
  // auto-placed into the FIRST grid track (the 3.4rem folio-number column)
  // instead of the wide middle column, wrapping the serif title narrowly.
  // The fix reuses the SAME LedgerRow the /blog ledger renders through, so a
  // Pages entry's markup shape is a structural subset (no folio/meta) of a
  // Writing entry's — this pins that shared shape so a future change can't
  // reintroduce a bespoke, incompatible row component.
  test("issue 059 — a pages-index row is the shared LedgerRow shape (<a class=\"row\"><span class=\"mid\"><span class=\"title\">), not a bespoke layout", () => {
    const html = renderFull(mockCtx(PAGE_LIST, "light"));
    expect(html).toContain(
      '<a class="row" href="/pages/about"><span class="mid"><span class="title">About Me</span></span></a>',
    );
  });
});

// ── Issue 061 — tags index (/tags) ────────────────────────────────────────────

const TAG_LIST: ThemeContent = {
  kind: "tag-list",
  tags: [
    { name: "Bash", slug: "bash", count: 1 },
    { name: "Docker", slug: "docker", count: 3 },
  ],
};

describe("Issue 061 — tags index (/tags) renders a listing instead of 404ing", () => {
  test("tag-list template renders every tag, with its count, linking to /tags/<slug>", () => {
    const html = renderFull(mockCtx(TAG_LIST, "light"));
    expect(html).toContain("Bash");
    expect(html).toContain('href="/tags/bash"');
    expect(html).toContain("1 post");
    expect(html).toContain("Docker");
    expect(html).toContain('href="/tags/docker"');
    expect(html).toContain("3 posts");
  });

  test("tag-list title is 'Tags — site title'", () => {
    const html = renderFull(mockCtx(TAG_LIST, "light"));
    expect(html).toContain("<title>Tags — Alex Rivera</title>");
  });

  test("tag-list template renders a register header consistent with the pages/blog indexes", () => {
    const html = renderFull(mockCtx(TAG_LIST, "light"));
    expect(html).toContain("Tags");
    expect(html).toContain("ledger-wrap");
  });

  test("tag-list uses the shared LedgerRow shape (same as /pages, minus the folio number)", () => {
    const html = renderFull(mockCtx(TAG_LIST, "light"));
    expect(html).toContain(
      '<a class="row" href="/tags/bash"><span class="mid"><span class="title">Bash</span></span><span class="meta">1 post</span></a>',
    );
  });

  test("tag-list with no tags renders an empty message, not a crash (empty state, issue 061 AC)", () => {
    const emptyList: ThemeContent = { kind: "tag-list", tags: [] };
    expect(() => renderFull(mockCtx(emptyList, "light"))).not.toThrow();
    const html = renderFull(mockCtx(emptyList, "light"));
    expect(html).toContain("No tags published yet.");
  });
});

// ── Issue 012 — home rework: intro deck + featured showcase ──────────────────

describe("Issue 012 — home intro deck (home.intro setting)", () => {
  test("intro renders in the serif-italic .deck voice when set", () => {
    const html = renderFull(mockCtx(HOME_FEATURED, "light"));
    expect(html).toContain("deck");
    expect(html).toContain(
      "I build quiet infrastructure and photograph the walks in between.",
    );
  });

  test("deck is omitted entirely when intro is null (no fallback)", () => {
    const html = renderFull(mockCtx(HOME, "light")); // HOME.intro === null
    expect(html).not.toContain('class="deck"');
    // and it must NOT fall back to site.description in the hero body
    // (site.description still appears in the masthead runline, so scope the check
    // to the absence of a deck element rather than the string).
  });
});

describe("Issue 012 — featured showcase (§ 00 · Selected)", () => {
  test("zero featured ⇒ the § 00 section is omitted entirely", () => {
    const html = renderFull(mockCtx(HOME, "light")); // HOME.featured === []
    expect(html).not.toContain('aria-label="Selected work"');
    expect(html).not.toContain("§ 00");
  });

  test("featured items render as cards linking to the right listing", () => {
    const html = renderFull(mockCtx(HOME_FEATURED, "light"));
    expect(html).toContain('aria-label="Selected work"');
    expect(html).toContain("§ 00");
    // lead essay → /blog/<slug>; supporting photo → /photos/<slug>
    expect(html).toContain('href="/blog/snowmelt"');
    expect(html).toContain('href="/photos/meltwater"');
    expect(html).toContain('href="/blog/backups"');
  });

  test("the first featured item is the lead spread (excerpt + read affordance)", () => {
    const html = renderFull(mockCtx(HOME_FEATURED, "light"));
    expect(html).toContain("feat lead");
    expect(html).toContain(
      "On the hydrology of a small valley and capacity planning.",
    );
    expect(html).toContain("Read the essay →");
  });

  test("a featured item with a cover renders an <img> plate", () => {
    const html = renderFull(mockCtx(HOME_FEATURED, "light"));
    expect(html).toContain('src="/media/snow/800.jpg"');
    expect(html).toContain('alt="A snow-covered ridge"');
  });

  test("a featured item with NO cover renders a typographic plate (title inside)", () => {
    const html = renderFull(mockCtx(HOME_FEATURED, "light"));
    // The no-cover essay's title moves into a .plate.typo (serif italic .t-title).
    expect(html).toContain("plate typo");
    expect(html).toContain("t-title");
    expect(html).toContain("Backups you have actually restored");
  });

  test("kind label discriminates Essay vs Photograph; essays show reading length", () => {
    const html = renderFull(mockCtx(HOME_FEATURED, "light"));
    expect(html).toContain("Essay");
    expect(html).toContain("Photograph");
    expect(html).toContain("11 min"); // lead essay reading length
  });

  test("register ghost reports rotation honestly when over the cap", () => {
    // featuredTotal 5, showing 3 → "5 featured · 3 in rotation"
    const html = renderFull(mockCtx(HOME_FEATURED, "light"));
    expect(html).toContain("5 featured · 3 in rotation");
  });

  test("no plate numbers on featured cards (rotation would make a number a lie)", () => {
    const html = renderFull(mockCtx(HOME_FEATURED, "light"));
    // The photo grid uses "Pl. NN"; the showcase must not.
    expect(html).not.toContain("Pl. 0");
  });
});

describe("Issue 012 — home writing ledger is capped with a full-index link", () => {
  test("ledger shows recent entries; folio Nº uses the absolute total", () => {
    // A home with 8 published posts should show 6 rows numbered 8..3 and a link.
    const many = Array.from({ length: 8 }, (_, i) => ({
      title: `Entry ${i}`,
      slug: `e${i}`,
      excerpt: "",
      coverImage: null,
      publishedAt: `2026-0${i + 1}-01T00:00:00.000Z`,
      readingLength: 3,
      galleryCount: 0,      panoramic: false,
      type: "article" as const,
      tags: [],
    }));
    const content: ThemeContent = {
      kind: "home",
      posts: many.reverse(), // newest-first
      featured: [],
      featuredTotal: 0,
      intro: null,
    };
    const html = renderFull(mockCtx(content, "light"));
    expect(html).toContain("Nº 8"); // newest carries the absolute total
    expect(html).toContain("six most recent");
    expect(html).toContain("The full index →");
    expect(html).toContain('href="/blog"');
    // The 7th/8th oldest rows are NOT rendered on the home (capped at 6).
    expect(html).not.toContain("Nº 2");
  });
});

// ── V-019 — photo-item lightbox ──────────────────────────────────────────────
// The lightbox JS/CSS are loaded when route.kind === "photo-post". The test
// uses a ctx override that sets route.kind to "photo-post" (as the live route
// handler does) rather than "post" (as the generic mockCtx does for photo-post
// content, which is only used for back-affordance mapping in tests above).

function mockCtxPhotoPost(): ThemeRenderContext {
  const ctx = mockCtx(PHOTO_POST, "light");
  return {
    ...ctx,
    route: { ...ctx.route, kind: "photo-post" as const },
  };
}

describe("V-019 — photo-item lightbox (route.kind=photo-post)", () => {
  test("lightbox CSS is loaded on photo-post routes", () => {
    const html = renderFull(mockCtxPhotoPost());
    expect(html).toContain("/vendor/lightbox/lightbox.css");
  });

  test("lightbox JS is loaded on photo-post routes", () => {
    const html = renderFull(mockCtxPhotoPost());
    expect(html).toContain("/vendor/lightbox/lightbox.js");
  });

  test("cover image is wrapped in a .glightbox anchor on photo-post pages", () => {
    const html = renderFull(mockCtxPhotoPost());
    expect(html).toContain('class="glightbox"');
    // href of the anchor equals the cover image src.
    expect(html).toContain('href="/media/sunset/1200.jpg"');
  });

  test("lightbox CSS is NOT loaded on regular blog-post routes", () => {
    const html = renderFull(mockCtx(POST, "light"));
    expect(html).not.toContain("/vendor/lightbox/lightbox.css");
  });

  test("lightbox is loaded on photo-list routes (existing behavior preserved)", () => {
    const html = renderFull(mockCtx(PHOTO_LIST, "light"));
    expect(html).toContain("/vendor/lightbox/lightbox.css");
    expect(html).toContain("/vendor/lightbox/lightbox.js");
  });
});

describe("Issue 040 — .wrap-descended sections never clobber the horizontal gutter", () => {
  // Every public page type nests its body in <SOMETHING className="wrap X">.
  // .wrap sets padding-inline:var(--gutter); a `padding: A B C` shorthand on X
  // (equal specificity, later in cascade) sets padding-inline back to 0 and
  // silently strips the gutter below the element's own max-width breakpoint —
  // invisible on desktop (side whitespace from centering hides it), but text
  // runs flush to the screen edge on mobile. Bit .home once (issue 012) and
  // .article/.ledger-wrap/.gallery-wrap a second time (issue 040). This is a
  // static-CSS guard, not a rendered-layout test: it asserts every selector
  // that is paired with "wrap" in the theme markup uses padding-block (or an
  // explicit padding-inline) rather than a bare `padding:` shorthand, so the
  // clobber can't silently reappear on a class this test doesn't yet know
  // about without a human noticing the assertion needs updating.
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const css = fs.readFileSync(
    path.join(__dirname, "../../../../public/themes/editorial/theme.css"),
    "utf8",
  );
  const tsx = fs.readFileSync(path.join(__dirname, "../theme.tsx"), "utf8");

  // Every class paired with "wrap" in a className string, e.g. "wrap article".
  const wrapPartners = Array.from(
    tsx.matchAll(/className="wrap ([\w-]+)"/g),
  ).map((m) => m[1]);

  test("theme.tsx actually pairs \"wrap\" with at least one section class (sanity check the extraction works)", () => {
    expect(wrapPartners.length).toBeGreaterThan(0);
    expect(wrapPartners).toEqual(
      expect.arrayContaining(["home", "article", "ledger-wrap", "gallery-wrap"]),
    );
  });

  for (const cls of Array.from(new Set(wrapPartners))) {
    test(`.${cls} does not use a bare "padding:" shorthand (would clobber .wrap's padding-inline)`, () => {
      // Match the selector's own rule block: ".cls{...}" (theme.css is minified,
      // one selector per line/rule, no nested selectors of this exact name).
      const ruleMatch = css.match(new RegExp(`\\.${cls}\\{([^}]*)\\}`));
      expect(ruleMatch).not.toBeNull();
      const body = ruleMatch![1];
      // A bare `padding:` (not padding-inline/padding-block/padding-top/etc.)
      // is the clobber shape. Allow it only if the same rule ALSO sets
      // padding-inline explicitly (which would neutralize the clobber).
      const hasBarePadding = /(?:^|;)\s*padding\s*:/.test(body);
      const hasExplicitInline = /padding-inline\s*:/.test(body);
      if (hasBarePadding) {
        expect(hasExplicitInline).toBe(true);
      }
    });
  }
});
