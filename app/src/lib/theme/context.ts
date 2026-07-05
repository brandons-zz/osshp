// The public-only ThemeRenderContext builder (theme-rendering-contract §3).
//
// SECURITY — the §3.1 hard rule, enforced BY CONSTRUCTION:
//   * Settings reach the context ONLY through getPublicSettings(db), which filters
//     to visibility='public' at the SQL level. The admin user record, secrets,
//     and admin-only settings are never read here — there is no code path to them.
//   * Content reaches the context ONLY through the published-only reads
//     (listPublishedPosts / getPublishedPostBySlug / getPublishedPageBySlug);
//     draft and scheduled content never materialize (§3.3).
//   * Bodies are sanitized through the app-owned pipeline (renderMarkdown) before
//     they enter the context — a theme renders SanitizedHtml, never raw input.
// The ThemeRenderContext type itself has no field for admin/secret material, so
// the omission is total: a theme cannot reach it even by mistake.

import type { Db } from "@/lib/db/types";
import {
  getPublicSettings,
  getPublishedPageBySlug,
  getPublishedPostBySlug,
  listPublishedPosts,
  listPublishedFeatured,
  listPublishedPages,
  listPublishedPagesForNav,
} from "@/lib/content";
import type { Page, Post, Tag } from "@/lib/content";
// Module-id constants only — both manifest modules have zero runtime imports
// (their only import is `import type { ModuleManifest }`), so this does not
// create a theme↔module circular dependency; it's just two string constants.
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";
// Pure, dependency-free helper (no registry import) — safe here without creating
// a theme↔module runtime cycle (issue 053 defect: filter disabled-module nav).
import { hrefTargetsDisabledModule } from "@/lib/module/nav-guard";
import { resolveBrandTokens, type BrandInput } from "./brand";
import { renderMarkdown } from "./sanitize";
import { resolveScheme } from "./scheme";
import { emptySlots, type SlotContribution, collectSlots } from "./registry";
import type {
  PublicPage,
  PublicPageSummary,
  PublicPost,
  PublicPostSummary,
  PublicTag,
  PublicTagSummary,
  RouteInfo,
  SanitizedSlotOutput,
  Scheme,
  SchemeSetting,
  SiteIdentity,
  ThemeContent,
  ThemeHelpers,
  ThemeRenderContext,
  ThemeSlotId,
} from "./types";

// ── Public projections (Post/Page/Tag → public shapes; §3.3) ─────────────────

export function toPublicTag(tag: Tag): PublicTag {
  return { name: tag.name, slug: tag.slug };
}

/** Tag + its visible-post count → the /tags index entry shape (issue 061). */
export function toPublicTagSummary(entry: { tag: Tag; count: number }): PublicTagSummary {
  return { name: entry.tag.name, slug: entry.tag.slug, count: entry.count };
}

/** ≥16:9 landscape → a wide (span-2) album plate (spec §3, decision 8). */
const WIDE_RATIO = 16 / 9;
function isWide(width: number | null, height: number | null): boolean {
  return !!width && !!height && height > 0 && width / height >= WIDE_RATIO;
}

export function toPublicPost(post: Post): PublicPost {
  return {
    title: post.title,
    slug: post.slug,
    bodyHtml: renderMarkdown(post.body), // sanitized (§9)
    excerpt: post.excerpt,
    coverImage: post.coverImage,
    type: post.type,
    panoramic: post.panoramic,
    // Gallery album images (issue 047) — empty for Single posts and articles.
    gallery: post.isGallery
      ? post.gallery.map((g) => ({
          src: g.src,
          alt: g.alt,
          caption: g.caption,
          wide: isWide(g.width, g.height),
        }))
      : [],
    publishedAt: post.publishDate ?? post.createdAt,
    tags: post.tags.map(toPublicTag),
  };
}

export function toPublicPostSummary(post: Post): PublicPostSummary {
  // Reading length: word count of the markdown source at ~200 wpm (min 1 min).
  const wordCount = post.body.split(/\s+/).filter(Boolean).length;
  return {
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    coverImage: post.coverImage,
    publishedAt: post.publishDate ?? post.createdAt,
    readingLength: Math.max(1, Math.ceil(wordCount / 200)),
    panoramic: post.panoramic,
    // Needed so themes can generate the correct listing link URL:
    // articles → /blog/<slug>; photo-posts → /photos/<slug> (even when
    // show_in_blog opts them into the blog listing stream).
    type: post.type,
    // Gallery album size (issue 047): 0 for a Single photo post / article; the
    // count drives the index badge + the gallery-plate "links to page" behavior.
    galleryCount: post.isGallery ? post.gallery.length : 0,
    tags: post.tags.map(toPublicTag),
  };
}

export function toPublicPage(page: Page): PublicPage {
  return {
    title: page.title,
    slug: page.slug,
    bodyHtml: renderMarkdown(page.body), // sanitized (§9)
  };
}

export function toPublicPageSummary(page: Page): PublicPageSummary {
  return {
    title: page.title,
    slug: page.slug,
  };
}

// ── Site identity (PUBLIC settings subset only; §3.1) ────────────────────────

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/**
 * Build site identity from the PUBLIC settings map. The input is already
 * public-filtered by getPublicSettings — this function reads named public keys
 * only and cannot surface anything that wasn't marked public.
 */
export function buildSiteIdentity(
  publicSettings: Record<string, unknown>,
): SiteIdentity {
  const nav = publicSettings["site.nav"];
  const social = publicSettings["site.social"];
  const logo = publicSettings["site.logo"];
  const scheme = publicSettings["branding.defaultScheme"];
  return {
    title: asString(publicSettings["site.title"]),
    description: asString(publicSettings["site.description"]),
    // D1 — per-item guard: keep only objects with the required string fields so
    // a malformed DB-stored array (null, number, missing label/href) never reaches
    // the theme's .map() and crashes the public site with a 500.
    nav: Array.isArray(nav)
      ? (nav as unknown[]).filter(
          (item): item is { label: string; href: string } =>
            item !== null &&
            typeof item === "object" &&
            typeof (item as Record<string, unknown>)["label"] === "string" &&
            typeof (item as Record<string, unknown>)["href"] === "string",
        )
      : [],
    social: Array.isArray(social)
      ? (social as unknown[]).filter(
          (item): item is { network: string; href: string } =>
            item !== null &&
            typeof item === "object" &&
            typeof (item as Record<string, unknown>)["network"] === "string" &&
            typeof (item as Record<string, unknown>)["href"] === "string",
        )
      : [],
    logo:
      logo && typeof logo === "object"
        ? (logo as SiteIdentity["logo"])
        : null,
    defaultScheme:
      scheme === "light" || scheme === "dark" || scheme === "auto"
        ? scheme
        : "auto",
    locale: asString(publicSettings["site.locale"], "en"),
  };
}

/** Branding inputs for the AA guardrail, read from PUBLIC settings only. */
export function getBrandInput(
  publicSettings: Record<string, unknown>,
): BrandInput {
  return {
    accent: asString(publicSettings["branding.accent"], "#2563eb"),
    fontHeading:
      (publicSettings["branding.fontHeading"] as string | null) ?? null,
    fontBody: (publicSettings["branding.fontBody"] as string | null) ?? null,
  };
}

// ── Default presentation helpers (no I/O; §3.1) ──────────────────────────────

export function defaultHelpers(locale: string): ThemeHelpers {
  return {
    // Media keys resolve to public URLs; the Garage-backed resolver is M2.4.
    assetUrl: (key: string) => `/media/${key}`,
    // UTC-explicit to avoid SSR/client hydration mismatch.
    formatDate: (iso: string, opts?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...opts }).format(
        new Date(iso),
      ),
    excerpt: (html: string, max: number) => {
      const text = html.replace(/<[^>]*>/g, "").trim();
      return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
    },
  };
}

// ── Featured showcase selection (issue 012) ──────────────────────────────────

/** Max featured items shown on the home at once (1 lead + up to 3 supporting). */
export const FEATURED_CAP = 4;

/**
 * Select which featured items to display in the home showcase.
 *
 * `all` arrives newest-first. When the featured set is at or below the cap, it is
 * returned unchanged (newest-first). When more than `cap` are featured, a random
 * subset of `cap` is chosen (so a large featured set ROTATES per page load rather
 * than overflowing), then re-sorted newest-first within the selection (the lead
 * is always the newest of the chosen four). `rng` is injectable for deterministic
 * tests; production uses Math.random per request.
 */
export function selectFeatured(
  all: readonly PublicPostSummary[],
  cap: number = FEATURED_CAP,
  rng: () => number = Math.random,
): PublicPostSummary[] {
  if (all.length <= cap) return [...all];
  const pool = [...all];
  // Fisher–Yates shuffle, then take the first `cap`.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, cap).sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
}

// ── Module-enabled filtering (issue 028, extended by issue 074) ──────────────
//
// The home/post-list/tag/tag-list queries (below) read content WITHOUT going
// through a module's own route handler — every module's OWN route (`/blog`,
// `/photos`, ...) already self-checks `isModuleEnabled` before it ever calls
// into content/theme code (see e.g. app/blog/route.ts). Disabling a module
// correctly 404s its own routes, but a post/photo it owns can still be
// featured, recent, tagged, or listed by ANOTHER surface that reads posts
// directly — home's showcase/ledger (issue 028), and /blog's post-list,
// /tags/<slug>, and the /tags index (issue 074). This map + filter (and
// aggregateTagCounts below, for the tag-list case's differently-shaped data)
// closes that gap everywhere `resolveContent` reads posts without a route
// gate in front of it. /rss.xml applies the same filter directly (it does not
// go through resolveContent).

const POST_TYPE_MODULE_ID: Record<Post["type"], string> = {
  article: BLOG_MODULE_ID,
  "photo-post": PHOTOS_MODULE_ID,
};

/**
 * Drop posts whose owning module is disabled. `enabledModuleIds` is undefined
 * when the caller hasn't supplied one (e.g. a test building content directly) —
 * in that case nothing is filtered, preserving prior behavior.
 */
function filterByEnabledModules(
  posts: readonly Post[],
  enabledModuleIds: readonly string[] | undefined,
): Post[] {
  if (!enabledModuleIds) return [...posts];
  return posts.filter((p) => enabledModuleIds.includes(POST_TYPE_MODULE_ID[p.type]));
}

/**
 * Aggregate {tag, count} entries from an (already enabled-module-filtered)
 * post list — mirrors listPublishedTagCounts's SQL join (each post-tag
 * pairing counted once, ordered by tag name) but operating on an in-memory
 * Post[] so the tag-list case can apply the SAME filterByEnabledModules used
 * by "home"/"post-list"/"tag" (issue 074) instead of a second, SQL-level
 * filtering mechanism. A tag whose only visible post belongs to a disabled
 * module is simply absent from `posts` and so never appears here.
 */
function aggregateTagCounts(posts: readonly Post[]): Array<{ tag: Tag; count: number }> {
  const byId = new Map<string, { tag: Tag; count: number }>();
  for (const post of posts) {
    for (const tag of post.tags) {
      const entry = byId.get(tag.id);
      if (entry) entry.count += 1;
      else byId.set(tag.id, { tag, count: 1 });
    }
  }
  return [...byId.values()].sort((a, b) => a.tag.name.localeCompare(b.tag.name));
}

// ── Route request → resolved content ─────────────────────────────────────────

export type RouteRequest =
  | { kind: "home"; canonicalUrl?: string }
  | { kind: "post" | "photo-post"; slug: string; canonicalUrl?: string }
  | { kind: "page"; slug: string; canonicalUrl?: string }
  | { kind: "post-list"; canonicalUrl?: string }
  | { kind: "photo-list"; canonicalUrl?: string }
  | { kind: "tag"; slug: string; canonicalUrl?: string }
  | { kind: "page-list"; canonicalUrl?: string }
  | { kind: "tag-list"; canonicalUrl?: string }
  | { kind: "not-found"; canonicalUrl?: string };

export interface BuildContextOptions {
  /** Visitor's persisted scheme override (cookie/localStorage), if any. */
  persistedScheme?: string | null;
  /** prefers-color-scheme value for resolving "auto" (default light). */
  prefersDark?: boolean;
  /** Module slot contributions (already sanitized). M1.5 supplies these. */
  slots?: readonly SlotContribution[];
  /** Enabled module ids (issue 028) — filters the home showcase/ledger so a
   *  disabled module's content never appears there, matching the 404 its own
   *  routes already return. Omitted (e.g. in tests) = no filtering. */
  enabledModuleIds?: readonly string[];
  /** Public-route nav bases of DISABLED modules (issue 053 defect). A saved
   *  `site.nav` item whose href targets one of these points at a route that now
   *  404s, so it is dropped from the rendered masthead — the public nav reflects
   *  current module state, not the stored config. Omitted = no filtering. The
   *  caller computes this from the registry (getDisabledModuleNavBases). */
  disabledModuleNavBases?: readonly string[];
}

async function resolveContent(
  db: Db,
  req: RouteRequest,
  publicSettings: Record<string, unknown>,
  enabledModuleIds: readonly string[] | undefined,
): Promise<{ content: ThemeContent; found: boolean }> {
  switch (req.kind) {
    case "post":
    case "photo-post": {
      const post = await getPublishedPostBySlug(db, req.slug);
      if (!post) return notFoundContent();
      return { content: { kind: req.kind, post: toPublicPost(post) }, found: true };
    }
    case "page": {
      const page = await getPublishedPageBySlug(db, req.slug);
      if (!page) return notFoundContent();
      return { content: { kind: "page", page: toPublicPage(page) }, found: true };
    }
    case "tag": {
      // Filtered to enabled modules (issue 074) — an ordinary article or
      // photo-post tagged and belonging to a disabled module must not list
      // here (its own route already 404s). The tag's display name/slug is
      // derived from the UNFILTERED result so the header still resolves even
      // when the filtered post list is empty (e.g. every tagged post
      // currently belongs to a disabled module).
      const rawPosts = await listPublishedPosts(db, { tagSlug: req.slug });
      const posts = filterByEnabledModules(rawPosts, enabledModuleIds);
      const tag = rawPosts[0]?.tags.find((t) => t.slug === req.slug);
      return {
        content: {
          kind: "tag",
          posts: posts.map(toPublicPostSummary),
          tag: tag ? toPublicTag(tag) : { name: req.slug, slug: req.slug },
        },
        found: true,
      };
    }
    case "home": {
      // Blog stream: articles always; photo-posts only when show_in_blog=true.
      // Filtered to enabled modules (issue 028) — a disabled module's posts
      // don't belong in the recent-writing ledger either.
      const posts = filterByEnabledModules(
        await listPublishedPosts(db, { blogStream: true }),
        enabledModuleIds,
      );
      // Featured showcase (issue 012): any published post/photo flagged featured,
      // newest-first; the server picks a random ≤4 subset (rotation) per load.
      // Filtered to enabled modules (issue 028) so a disabled module never
      // contributes a dead-link card to the showcase.
      const featuredAll = filterByEnabledModules(
        await listPublishedFeatured(db),
        enabledModuleIds,
      );
      const featured = selectFeatured(featuredAll.map(toPublicPostSummary));
      // home.intro — the serif-italic deck. Unset/blank ⇒ null (deck omitted, no
      // fallback to site.description, which already appears in the masthead).
      const introRaw = publicSettings["home.intro"];
      const intro =
        typeof introRaw === "string" && introRaw.trim() !== "" ? introRaw : null;
      return {
        content: {
          kind: "home",
          posts: posts.map(toPublicPostSummary),
          featured,
          featuredTotal: featuredAll.length,
          intro,
        },
        found: true,
      };
    }
    case "post-list": {
      // Blog stream: articles always; photo-posts only when show_in_blog=true.
      // Filtered to enabled modules (issue 074) — a disabled module's posts
      // don't belong in the /blog listing either (mirrors the "home" case).
      const posts = filterByEnabledModules(
        await listPublishedPosts(db, { blogStream: true }),
        enabledModuleIds,
      );
      return {
        content: { kind: "post-list", posts: posts.map(toPublicPostSummary) },
        found: true,
      };
    }
    case "photo-list": {
      // The Photos grid: published photo-posts only (the lightbox gallery).
      const posts = await listPublishedPosts(db, { type: "photo-post" });
      return {
        content: { kind: "photo-list", posts: posts.map(toPublicPostSummary) },
        found: true,
      };
    }
    case "page-list": {
      // Pages index — all published pages listed by title (V-010).
      const pages = await listPublishedPages(db);
      return {
        content: { kind: "page-list", pages: pages.map(toPublicPageSummary) },
        found: true,
      };
    }
    case "tag-list": {
      // Tags index (issue 061) — every tag with ≥1 visible post, with counts.
      // Filtered to enabled modules (issue 074) before aggregating counts —
      // a tag whose only visible post belongs to a disabled module must not
      // appear with a stale non-zero count linking to a page that 404s.
      const posts = filterByEnabledModules(await listPublishedPosts(db), enabledModuleIds);
      const counts = aggregateTagCounts(posts);
      return {
        content: { kind: "tag-list", tags: counts.map(toPublicTagSummary) },
        found: true,
      };
    }
    case "not-found":
      return notFoundContent();
  }
}

function notFoundContent(): { content: ThemeContent; found: boolean } {
  return { content: { kind: "post-list", posts: [] }, found: false };
}

function routeInfo(req: RouteRequest, found: boolean): RouteInfo {
  const kind = !found && req.kind !== "not-found" ? "not-found" : req.kind;
  return { kind, canonicalUrl: req.canonicalUrl ?? defaultCanonical(req) };
}

/**
 * Deployment origin from env — non-throwing, returns '' when not set (tests,
 * build time). Canonical URLs are absolute in production (OSSHP_ORIGIN set)
 * and relative in tests/build (no env), preserving the existing behavior.
 */
function deploymentOrigin(): string {
  return (process.env.OSSHP_ORIGIN ?? "").replace(/\/$/, "");
}

function defaultCanonical(req: RouteRequest): string {
  const o = deploymentOrigin();
  switch (req.kind) {
    case "home":
      return `${o}/`;
    case "post":
      return `${o}/blog/${req.slug}`;
    case "photo-post":
      // Photo-posts live at /photos/<slug>; /blog/<slug> is not a valid URL for them.
      return `${o}/photos/${req.slug}`;
    case "page":
      return `${o}/pages/${req.slug}`;
    case "post-list":
      return `${o}/blog`;
    case "photo-list":
      return `${o}/photos`;
    case "tag":
      return `${o}/tags/${req.slug}`;
    case "page-list":
      return `${o}/pages`;
    case "tag-list":
      return `${o}/tags`;
    case "not-found":
      return `${o}/404`;
  }
}

// ── Compose / build the context ──────────────────────────────────────────────

/** Pure assembly of the context from already-public inputs. */
export function composeRenderContext(args: {
  site: SiteIdentity;
  route: RouteInfo;
  content: ThemeContent;
  brand: ThemeRenderContext["brand"];
  scheme: Scheme;
  slots: Record<ThemeSlotId, SanitizedSlotOutput[]>;
  helpers: ThemeHelpers;
}): ThemeRenderContext {
  return {
    site: args.site,
    route: args.route,
    content: args.content,
    brand: args.brand,
    scheme: args.scheme,
    slots: args.slots,
    helpers: args.helpers,
  };
}

/**
 * Build the context from an already-fetched PUBLIC settings map (lets the engine
 * read settings once and reuse them for the Layer-3 brand CSS).
 */
export async function buildRenderContextFromSettings(
  db: Db,
  req: RouteRequest,
  publicSettings: Record<string, unknown>,
  opts: BuildContextOptions = {},
): Promise<ThemeRenderContext> {
  const baseSite = buildSiteIdentity(publicSettings);

  // V-010: Merge published pages with show_in_nav=true into the rendered nav.
  // The Settings-managed items come first; page-nav items append afterward.
  // Guard: skip a page whose /pages/<slug> URL is already in the settings nav
  // to avoid double-listing if an operator has also hand-added it via Settings.
  const pageNavPages = await listPublishedPagesForNav(db);
  const settingsNavHrefs = new Set(baseSite.nav.map((n) => n.href));
  const pageNavItems = pageNavPages
    .filter((p) => !settingsNavHrefs.has(`/pages/${p.slug}`))
    .map((p) => ({ label: p.title, href: `/pages/${p.slug}` }));

  // issue 053 defect — drop any saved nav item pointing at a DISABLED module's
  // public route so a visitor never clicks a live masthead link into a 404. A
  // module can be toggled off at any time, so the render must reflect current
  // module state rather than the stored nav config. Page-nav items (/pages/<slug>)
  // are never module routes, so they pass through untouched.
  const disabledBases = opts.disabledModuleNavBases ?? [];
  const mergedNav =
    disabledBases.length > 0
      ? [...baseSite.nav, ...pageNavItems].filter(
          (n) => !hrefTargetsDisabledModule(n.href, disabledBases),
        )
      : [...baseSite.nav, ...pageNavItems];
  const site: SiteIdentity = {
    ...baseSite,
    nav: mergedNav,
  };

  const scheme = resolveScheme(
    opts.persistedScheme,
    site.defaultScheme,
    opts.prefersDark ?? false,
  );
  const brand = resolveBrandTokens(getBrandInput(publicSettings), scheme);
  const { content, found } = await resolveContent(
    db,
    req,
    publicSettings,
    opts.enabledModuleIds,
  );
  const slots = opts.slots ? collectSlots(opts.slots) : emptySlots();

  return composeRenderContext({
    site,
    route: routeInfo(req, found),
    content,
    brand,
    scheme,
    slots,
    helpers: defaultHelpers(site.locale),
  });
}

/** Build the public-only render context for one route. */
export async function buildRenderContext(
  db: Db,
  req: RouteRequest,
  opts: BuildContextOptions = {},
): Promise<ThemeRenderContext> {
  const publicSettings = await getPublicSettings(db);
  return buildRenderContextFromSettings(db, req, publicSettings, opts);
}
