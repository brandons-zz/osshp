// The theme rendering contract — surface types (theme-rendering-contract §2–§9).
//
// These are the load-bearing seam between the app and a theme. The app owns
// WHAT (data, routing, auth, sanitization, scheme resolution, the AA guardrail,
// structural tokens); the theme owns HOW IT LOOKS (markup, layout, color/material
// tokens, slot placement). The single most important property here is enforced by
// SHAPE, not by good behavior: `ThemeRenderContext` has no field through which a
// theme could reach the admin user, secrets, admin-only settings, or any admin
// API handle (§3.1 hard rule, §9).

import type { ReactNode } from "react";

/**
 * HTML that has passed the app-owned sanitizer (see ./sanitize). Branded so it
 * can only be produced by that module — a theme or module cannot mint one from
 * unsanitized input. The brand symbol is intentionally unexported.
 */
declare const SANITIZED_BRAND: unique symbol;
export type SanitizedHtml = string & { readonly [SANITIZED_BRAND]: true };

// ── Color scheme ────────────────────────────────────────────────────────────

export type Scheme = "light" | "dark";
export type SchemeSetting = Scheme | "auto";

// ── Render targets (§3.2) — an append-only enum ──────────────────────────────

/** Content render targets a theme provides a template for. */
export type ContentTargetId =
  | "home"
  | "post"
  | "page"
  | "post-list"
  | "photo-list"
  | "tag"
  | "page-list"
  | "not-found";

/** Every render target, including the document shell (§3.2). */
export type ThemeTargetId = "document" | ContentTargetId;

/** Every content render target (§3.2) — the fixed set a module content type may
 * map onto via `core-render-target` (module-contract §3.3). Runtime companion to
 * the `ContentTargetId` type so other layers validate against one source, not a
 * forked copy of the enum. */
export const CONTENT_TARGET_IDS: readonly ContentTargetId[] = [
  "home",
  "post",
  "page",
  "post-list",
  "photo-list",
  "tag",
  "page-list",
  "not-found",
];

/** Content targets a theme MUST provide; others fall back (§3.2). */
export const REQUIRED_CONTENT_TARGETS: readonly ContentTargetId[] = [
  "home",
  "post",
  "page",
  "post-list",
];

// ── Slots (§8) — named module extension points, an append-only enum ──────────

export type ThemeSlotId =
  | "head.meta"
  | "header.nav"
  | "post.belowBody"
  | "post.aside"
  | "footer.widgets"
  | "home.section";

export const THEME_SLOT_IDS: readonly ThemeSlotId[] = [
  "head.meta",
  "header.nav",
  "post.belowBody",
  "post.aside",
  "footer.widgets",
  "home.section",
];

/** Sanitized presentation output a module contributes to a slot (§8.1). */
export interface SanitizedSlotOutput {
  sourceModuleId: string;
  order: number;
  html: SanitizedHtml;
}

// ── Public content projections (§3.3) — only published content ever appears ──

export interface PublicTag {
  name: string;
  slug: string;
}

export interface PublicImageRef {
  src: string;
  alt: string;
}

export interface PublicPost {
  title: string;
  slug: string;
  bodyHtml: SanitizedHtml;
  excerpt: string;
  coverImage: PublicImageRef | null;
  type: "article" | "photo-post";
  /** True when this photo-post is panoramic (span-2 .wide tile in the grid). */
  panoramic: boolean;
  publishedAt: string; // ISO
  tags: PublicTag[];
}

export interface PublicPostSummary {
  title: string;
  slug: string;
  excerpt: string;
  coverImage: PublicImageRef | null;
  publishedAt: string;
  /** Estimated reading time in minutes (~200 wpm, min 1). */
  readingLength: number;
  /** True when this photo-post is panoramic (span-2 .wide tile in the grid). */
  panoramic: boolean;
  /**
   * Post type — themes use this to generate the correct link URL in listing views.
   * An 'article' links to /blog/<slug>; a 'photo-post' links to /photos/<slug>
   * (even when show_in_blog opts it into the blog listing).
   */
  type: "article" | "photo-post";
  tags: PublicTag[];
}

export interface PublicPage {
  title: string;
  slug: string;
  bodyHtml: SanitizedHtml;
}

/** Minimal public projection for the pages index listing (V-010). */
export interface PublicPageSummary {
  title: string;
  slug: string;
}

/** Discriminated on route.kind (§3.3). */
export type ThemeContent =
  | { kind: "post" | "photo-post"; post: PublicPost }
  | { kind: "page"; page: PublicPage }
  | {
      // "photo-list" reuses the summary projection (it carries coverImage, the
      // grid tile + lightbox source); a theme without a photo-list template
      // falls back to post-list (engine.pickTemplate).
      kind: "post-list" | "photo-list" | "tag";
      posts: PublicPostSummary[];
      tag?: PublicTag;
    }
  | {
      // Home (issue 012). `posts` is the full published blog stream (the theme
      // shows the recent slice as the ledger + the total for the specline).
      // `featured` is the ≤4 selected showcase items (server-side random subset
      // when over-featured, then newest-first); `featuredTotal` is the full
      // featured count for the honest register ghost; `intro` is the home.intro
      // setting (null when unset — the deck is omitted, no fallback).
      kind: "home";
      posts: PublicPostSummary[];
      featured: PublicPostSummary[];
      featuredTotal: number;
      intro: string | null;
    }
  | {
      // Pages index — all published pages by title + slug (V-010).
      kind: "page-list";
      pages: PublicPageSummary[];
    };

// ── Already-AA-safe brand tokens (§7) — derived by the APP, never the theme ──

export interface ResolvedBrandTokens {
  accentSolid: string; // ≥3:1 vs surface (1.4.11)
  accentText: string; // ≥4.5:1 vs --bg (1.4.3); also the focus-ring color
  onAccent: string; // auto white/near-black, ≥4.5:1 on accentSolid (1.4.3)
  fontHeading: string;
  fontBody: string;
  fontMono: string;
}

// ── Public site identity & chrome (§3.1) — PUBLIC settings subset only ───────

export interface SiteIdentity {
  title: string;
  description: string;
  nav: Array<{ label: string; href: string }>;
  social: Array<{ network: string; href: string }>;
  logo: { src: string; alt: string } | null;
  defaultScheme: SchemeSetting;
  locale: string;
}

// ── Route descriptor for THIS request (§3.1) ─────────────────────────────────

export interface RouteInfo {
  kind:
    | "home"
    | "post"
    | "page"
    | "post-list"
    | "photo-list"
    | "tag"
    | "photo-post"
    | "page-list"
    | "not-found";
  canonicalUrl: string;
  pagination?: {
    page: number;
    pageCount: number;
    prevHref?: string;
    nextHref?: string;
  };
}

// ── Pure presentation helpers (no I/O) ───────────────────────────────────────

export interface ThemeHelpers {
  assetUrl(key: string): string;
  formatDate(iso: string, opts?: Intl.DateTimeFormatOptions): string;
  excerpt(html: string, max: number): string;
}

// ── The single read-only, public-only context handed to a theme (§3.1) ───────

export interface ThemeRenderContext {
  site: SiteIdentity;
  route: RouteInfo;
  content: ThemeContent;
  brand: ResolvedBrandTokens;
  scheme: Scheme; // concrete; "auto" is resolved by the app before handoff
  slots: Readonly<Record<ThemeSlotId, ReadonlyArray<SanitizedSlotOutput>>>;
  helpers: ThemeHelpers;
}

// ── Templates & manifest (§2, §3.2) ──────────────────────────────────────────

/** A content template: read-only context in, server markup out. */
export type ThemeTemplate = (ctx: ThemeRenderContext) => ReactNode;

/**
 * What the app hands the `document` template so the theme owns the shell markup
 * while the app owns the no-flash hook and the Layer-1/Layer-3 token injection
 * (§6, §5.2). The document template's signature is distinct from content
 * templates because it wraps a rendered body.
 */
export interface DocumentShell {
  scheme: Scheme;
  /** Inline pre-paint script — app-provided, run before first paint (§6). */
  noFlashScript: string;
  /** Layer-1 app structural stylesheet href (loads first, §4). */
  structuralStylesheetHref: string;
  /** Layer-2 theme token stylesheet href (loads after structural, §4). */
  tokenStylesheetHref: string;
  /** Layer-3 brand tokens as a CSS string for BOTH schemes (§5.2, §7). */
  brandTokenCss: string;
  /**
   * Per-request CSP nonce (A1). The theme MUST place it on every inline
   * <script>/<style> it emits (no-flash hook, brand-token <style>, visitor toggle)
   * so they run under a nonce-based CSP. Undefined when the render path has no
   * active CSP (e.g. unit tests); inline elements then carry no nonce attribute.
   */
  nonce?: string;
  /** The already-rendered content body for this route. */
  body: ReactNode;
}

export type ThemeDocumentTemplate = (
  ctx: ThemeRenderContext,
  shell: DocumentShell,
) => ReactNode;

export interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  /** The document shell template (§3.2 `document` target, required). */
  document: ThemeDocumentTemplate;
  /** Content templates by target. Required targets must be present (§3.2). */
  templates: Partial<Record<ContentTargetId, ThemeTemplate>>;
  /** Layer-2 token stylesheet href (color-scheme values; §5.2). */
  tokenStylesheetHref: string;
  schemes: readonly ["light", "dark"];
}
