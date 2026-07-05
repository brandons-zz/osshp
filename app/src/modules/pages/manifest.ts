// The Pages/Portfolio module — the second first-party ModuleManifest (M2.10).
//
// Pages are self-contained, editor-authored content items (About, Portfolio,
// Contact…) that live at /pages/<slug> and render through the theme's fixed
// `page` render target (theme-rendering-contract §3.3). Unlike blog posts,
// pages have no tag system and no scheduled-reveal in the admin UI — just
// draft / published status and full Markdown authoring via the M2.8 TipTap
// editor.
//
// onDisable preserves all pages (§5 rule 2) — disable is a visibility change
// only. Re-enabling brings all page data back immediately.

import type { ModuleManifest } from "@/lib/module/types";

export const PAGES_MODULE_ID = "pages";

export const pagesModule: ModuleManifest = {
  id: PAGES_MODULE_ID,
  name: "Pages",
  description:
    "Create and publish static pages (About, Portfolio, Contact…). Pages render at /pages/<slug> through your theme.",
  version: "0.1.0",
  defaultEnabled: true,

  // §3.1 routes — public reading surface renders via the theme `page` target;
  // admin authoring surfaces are default-deny-classified.
  routes: [
    // access omitted → admin for the listing (default-deny fail-safe, §3.1 rule 1).
    { path: "/admin/pages", render: "admin-list" },
    { path: "/admin/pages/new", access: "admin", render: "admin-editor" },
    { path: "/admin/pages/[id]/edit", access: "admin", render: "admin-editor" },
    // Public reading at /pages/[slug] — explicitly "public".
    { path: "/pages/[slug]", access: "public", render: "page" },
  ],

  // §3.2 admin nav — points at this module's own admin root.
  adminNav: [{ label: "Pages", href: "/admin/pages", icon: "document", order: 20 }],

  // §3.3 content type — maps to the theme's fixed `page` render target.
  contentTypes: [
    {
      id: "page",
      fields: {
        title: "string",
        slug: "string",
        bodyMarkdown: "string",
      },
      statusModel: ["draft", "published"],
      publicRender: { mode: "core-render-target", target: "page" },
    },
  ],

  // §3.4 settings — no public settings for pages; postsPerPage is blog-specific.
  settings: {
    schema: [],
    panel: () => null,
  },

  // §3.5 theme hooks — none for pages.
  themeHooks: [],

  // §5 lifecycle — through core APIs only; disable never destroys pages.
  lifecycle: {
    // The `pages` table is core-owned and already migrated (0001_content_and_settings_core);
    // enable is a no-op beyond being listed in settings.enabledModules.
    onEnable: async () => {},
    // Deactivate only — pages and settings are retained for re-enable (§5 rule 2).
    onDisable: async () => {},
  },
};
