// The Photos module (M2.11) — photo posts + a public lightbox gallery grid.
//
// A photo post is a `posts` row with type='photo-post' (spec §8). Its cover image
// (uploaded through the M2.9 pipeline → EXIF/GPS stripped by default) is the grid
// tile AND the lightbox source. The public grid renders through the theme via the
// `photo-list` render target (the sanctioned "coordinated theme-contract enum
// append" for a new public shape, module-contract §3.3) — NOT a theme slot,
// because a slot's sanitized HTML would strip the `.glightbox`/data-* hooks the
// lightbox needs. The lightbox itself (GLightbox, MIT — see CREDITS.md) is loaded
// by the theme on the photo-list route only, nonce-carried under the CSP (A1).
//
// onDisable preserves all photo posts (§5 rule 2): the rows stay in the core
// `posts` table; disable only drops the id from site.enabledModules and makes the
// /photos grid inert. Re-enabling brings the gallery back immediately.

import type { ModuleManifest } from "@/lib/module/types";

export const PHOTOS_MODULE_ID = "photos";

export const photosModule: ModuleManifest = {
  id: PHOTOS_MODULE_ID,
  name: "Photos",
  description:
    "Publish photo posts as a lightbox gallery. The public grid renders at /photos through your theme.",
  version: "0.1.0",
  defaultEnabled: true,

  // §3.1 routes — public grid renders via the theme `photo-list` target; admin
  // authoring surfaces are default-deny-classified under this module's namespace.
  routes: [
    { path: "/photos", access: "public", render: "photo-list" },
    // access omitted → admin (default-deny fail-safe, §3.1 rule 1).
    { path: "/admin/photos", render: "admin-list" },
    { path: "/admin/photos/new", access: "admin", render: "admin-editor" },
    { path: "/admin/photos/[id]/edit", access: "admin", render: "admin-editor" },
  ],

  // §3.2 admin nav — href points at this module's own admin route.
  adminNav: [{ label: "Photos", href: "/admin/photos", icon: "image", order: 30 }],

  // §3.3 content type — a photo post maps to the theme's `post` render target for
  // single-item rendering; the gallery grid is the `photo-list` route target.
  contentTypes: [
    {
      id: "photo-post",
      fields: {
        title: "string",
        slug: "string",
        bodyMarkdown: "string",
        excerpt: "string",
        coverImage: "media-ref",
      },
      statusModel: ["draft", "published", "scheduled"],
      publicRender: { mode: "core-render-target", target: "post" },
    },
  ],

  // §3.4 settings — none for photos.
  settings: {
    schema: [],
    panel: () => null,
  },

  // §3.5 theme hooks — none; the grid is a render target, not a slot (a slot's
  // sanitized HTML cannot carry the lightbox's class/data hooks).
  themeHooks: [],

  // §5 lifecycle — photo posts live in the core `posts` table (already migrated);
  // enable/disable are visibility-only and never destroy content.
  lifecycle: {
    onEnable: async () => {},
    onDisable: async () => {},
  },
};
