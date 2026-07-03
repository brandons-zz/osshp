// The Blog module — the first real ModuleManifest, the walking skeleton's proof
// that the module contract expresses a first-party feature (module-contract §8).
//
// The manifest is the module's ENTIRE interface to the core. It declares:
//  - public reading routes (/blog, /blog/[slug], /tags/[slug]) that render through
//    the THEME via fixed render targets (post-list / post / tag);
//  - admin authoring routes (/admin/blog*, access omitted or "admin") that sit
//    behind the default-deny middleware and render through the admin shell;
//  - the `post` content type mapped to the theme's fixed `post` render target;
//  - settings with a public/admin split (postsPerPage public; defaultStatus admin);
//  - theme hooks contributing SanitizedSlotOutput to existing ThemeSlotIds.
// onDisable preserves all posts (§5 rule 2) — disable is a visibility change only.

import type { ModuleManifest } from "@/lib/module/types";

export const BLOG_MODULE_ID = "blog";

export const blogModule: ModuleManifest = {
  id: BLOG_MODULE_ID,
  name: "Blog",
  description:
    "Write and publish articles with tags. Public reading pages render through your theme.",
  version: "0.1.0",
  defaultEnabled: true,

  // §3.1 routes — public reading surfaces render via the theme; admin authoring
  // surfaces carry (or default to) admin and sit behind default-deny.
  routes: [
    { path: "/blog", access: "public", render: "post-list" },
    { path: "/blog/[slug]", access: "public", render: "post" },
    { path: "/tags/[slug]", access: "public", render: "tag" },
    // access omitted → admin (default-deny fail-safe, §3.1 rule 1).
    { path: "/admin/blog", render: "admin-list" },
    { path: "/admin/blog/new", access: "admin", render: "admin-editor" },
    { path: "/admin/blog/[id]/edit", access: "admin", render: "admin-editor" },
  ],

  // §3.2 admin nav — href points at this module's own admin route.
  adminNav: [{ label: "Blog", href: "/admin/blog", icon: "pencil", order: 10 }],

  // §3.3 content type — maps to the theme's fixed public render shapes; no
  // theme-contract change (Blog content fits the existing PublicPost model).
  contentTypes: [
    {
      id: "post",
      fields: {
        title: "string",
        slug: "string",
        bodyMarkdown: "string",
        excerpt: "string",
        tags: "tag[]",
      },
      statusModel: ["draft", "published", "scheduled"],
      publicRender: { mode: "core-render-target", target: "post" },
    },
  ],

  // §3.4 settings — public fields reach the theme; admin field never does.
  settings: {
    schema: [
      { key: "postsPerPage", type: "number", default: 10, visibility: "public" },
      // visibility omitted → admin (never reaches a theme, §3.4).
      { key: "defaultStatus", type: "enum", default: "draft" },
    ],
    // Admin panel UI is the admin authoring surface (built from owned components);
    // the skeleton's authoring lives at the declared /admin/blog routes.
    panel: () => null,
  },

  // §3.5 theme hooks — contribute to EXISTING ThemeSlotIds; output is SanitizedHtml
  // (the app sanitizes a module's output before it enters the render context).
  themeHooks: [
    {
      // RSS autodiscovery link — contributed to head.meta so it appears in <head>
      // ONLY when the Blog module is enabled. When Blog is disabled this hook is
      // never called, so a Blog-off operator's head contains no rss+xml alternate
      // link pointing at a 404 URL. Uses sanitizeHead
      // (the head-element sanitizer introduced alongside this hook) which allows
      // <link> elements — the body sanitizer strips them.
      slot: "head.meta",
      render: (ctx) => ({
        sourceModuleId: BLOG_MODULE_ID,
        order: 0,
        html: (ctx.sanitizeHead ?? ctx.sanitize)(
          '<link rel="alternate" type="application/rss+xml" title="RSS feed" href="/rss.xml">',
        ),
      }),
    },
    {
      slot: "footer.widgets",
      render: (ctx) => ({
        sourceModuleId: BLOG_MODULE_ID,
        order: 10,
        html: ctx.sanitize(
          '<p class="blog-footer-note">Subscribe via the <a href="/rss.xml">RSS feed</a>.</p>',
        ),
      }),
    },
  ],

  // §5 lifecycle — through core APIs only; disable never destroys posts.
  lifecycle: {
    // The post content type's storage is core-owned and already migrated; there
    // is no module-specific table to create, so enable is a no-op beyond being
    // listed in settings.enabledModules.
    onEnable: async () => {},
    // Deactivate only — posts and settings are retained for re-enable (§5 rule 2).
    onDisable: async () => {},
  },
};
