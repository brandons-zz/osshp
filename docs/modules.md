# osshp — Modules

**Audience:** operators deciding which features to run; contributors building
a new module.

osshp's core is deliberately minimal (auth, admin shell, content storage,
settings, the theme engine, and the module system itself). Everything else —
what you actually publish — is a **module**. Each first-party module declares
its own routes, admin navigation, content type, settings, and (where
relevant) theme-hook contributions through one declarative manifest; the
core mounts, toggles, and mediates all of it. See "Building a new module"
below for the full core↔module interface if you're building a new one; this
document is the operator-facing description-and-how-to for what ships
today.

**Shipped modules (v0.1):** Blog, Pages, Photos. All three are pre-checked
("enabled by default") in the setup wizard.

---

## Enabling and disabling a module

**At setup:** the setup wizard's third step ("Choose modules") lets you
uncheck any of the three before finishing setup — that's the supported way
to opt a module out from the start.

**After setup:** **Admin → Settings → Modules** has a checkbox per module
(Blog / Pages / Photos) — check or uncheck the ones you want live, then
**Save modules**. This submits the full desired module set to
`PATCH /api/admin/modules`, a dedicated route (not the general settings
form — `site.enabledModules` is deliberately excluded from that form's
writable-fields allowlist, because toggling a module has to run its
`onEnable`/`onDisable` lifecycle hook, not just overwrite a settings value).
The route is session-authenticated and CSRF/Origin-guarded like every other
admin write, and it rejects the whole request (no partial writes) if you
send an id that isn't a real, valid module.

**What disabling actually does:** per the module contract (§5), disabling a
module is reversible — its public routes 404, its admin section becomes
unreachable, and it drops from both the public and admin navigation, but it
**never deletes its content**. Re-enabling brings everything back
immediately, exactly as it was. Every module below documents this in its
own manifest with the same guarantee.

**Admin-lockout safeguard:** you can disable all three modules at once —
nothing stops you, and nothing strands you. **Settings, Account security,
Export/Backup, Import, and Dashboard** always stay reachable in the admin
nav regardless of which modules are on, so the Modules panel itself (your
way back in) is never behind a toggle you just turned off.

**Known gap (fast-follow, non-blocking for v0.1):** the home page's
featured showcase and recent-writing ledger don't yet check module-enabled
state when they query content. If you disable a module while one of its
posts is featured (or recent), the home page keeps linking to it — and
since the module's own routes are correctly gated, that link 404s. The
module's own pages, admin section, and nav entry are all correctly gated;
only the home page's cross-module aggregation isn't, yet. Tracked as
issue 028; re-enabling the module (or un-featuring the post first) clears
it in the meantime.

---

## Blog

> "Write and publish articles with tags."

**What it adds:**

- Public reading routes: `/blog` (paginated post list), `/blog/[slug]`
  (a single article), `/tags/[slug]` (tag-filtered list) — all rendered
  through your active theme.
- Admin authoring at `/admin/blog` (list), `/admin/blog/new`,
  `/admin/blog/[id]/edit` — full Markdown authoring via the TipTap-backed
  editor, drafts, and scheduled publishing.
- A `post` content type (title, slug, Markdown body, excerpt, cover image,
  tags), with `draft` / `published` / `scheduled` status.
- Two public settings: `postsPerPage` (default 10) and one admin-only
  setting, `defaultStatus` (default `draft`).
- Theme-hook contributions: an RSS `<link rel="alternate">` autodiscovery tag
  in `head.meta` (only present while Blog is enabled — a disabled Blog
  produces no dangling RSS link), and a "Subscribe via RSS" note in
  `footer.widgets`.
- The site's RSS feed (`/rss.xml`) reflects published posts.

**Usage example:** write a post at **Admin → Blog → New post**, fill in a
title and Markdown body, add tags (created inline as you type them), set
**Status: Published**, save. It's now live at `/blog/<slug>` and appears at
the top of `/blog` and in `/rss.xml`. Set **Status: Scheduled** with a future
publish date instead to have it go live automatically at that time.

## Pages

> "Create and publish static pages (About, Portfolio, Contact…)."

**What it adds:**

- Public reading route `/pages/[slug]`, rendered through your active theme's
  `page` render target.
- Admin authoring at `/admin/pages` (list), `/admin/pages/new`,
  `/admin/pages/[id]/edit` — same Markdown editor as Blog, no tags, no
  scheduling (`draft` / `published` only — a page is either live or it
  isn't).
- A `page` content type (title, slug, Markdown body).
- A per-page **"Show in navigation"** toggle (`showInNav`): pages with this
  checked appear automatically in the site's navigation, alongside whatever
  nav items you've configured manually in **Admin → Settings → Navigation &
  social**.
- No public or admin settings of its own; no theme-hook contributions.

**Usage example:** create an About page at **Admin → Pages → New page**,
write your bio in Markdown, check **Show in navigation**, set
**Status: Published**, save. It's live at `/pages/about` and now appears in
your site's nav bar with no further configuration.

## Photos

> "Publish photo posts as a lightbox gallery."

**What it adds:**

- Public gallery grid at `/photos`, rendered through your theme's dedicated
  `photo-list` render target (not a theme slot — a slot's sanitized output
  can't carry the interactive hooks the lightbox needs, so this content type
  gets its own coordinated render target instead, per the theme contract's
  append-only-enum extension rule).
- Clicking any grid tile opens a first-party, dependency-free lightbox
  (`app/public/vendor/lightbox/`) — keyboard-operable, CSP-strict by
  construction (no inline `style=` attributes; see `CREDITS.md` for why this
  replaced an earlier third-party lightbox).
- Admin authoring at `/admin/photos` (list), `/admin/photos/new`,
  `/admin/photos/[id]/edit`.
- A `photo-post` content type — same shape as a Blog post (title, slug, body,
  excerpt, cover image) plus `draft` / `published` / `scheduled` status. A
  photo post is stored as a `posts` row with `type: 'photo-post'`.
- **Photo-posts default to `/photos` only** — they do not appear in the
  `/blog` stream by default. Each photo post carries a **"Show in blog
  stream"** toggle (`showInBlog`) an operator can flip on individually to
  opt that one post into the blog timeline as well; the reverse (removing it
  from `/photos`) is not offered — a photo post always shows in the gallery.
- Uploaded images are processed by the shared M2.9 media pipeline: resized
  to responsive variants and **EXIF/GPS data is stripped by default** before
  storage — cover-image location metadata never leaks through a published
  photo.
- No settings of its own; no theme-hook contributions (the grid is a render
  target, as above).

**Usage example:** upload a photo at **Admin → Photos → New photo**, add a
title and optional caption/body, set **Status: Published**, save. It's live
as a tile at `/photos`; clicking it opens the lightbox. Check
**Show in blog stream** if you also want this post to appear in your regular
`/blog` timeline (e.g. a travel photo you're writing about at length).

---

## Home page — the featured showcase

The home page (`/`) is where content from Blog and Photos meets — it isn't
owned by either module. Two pieces of it are yours to set up:

**The intro.** **Admin → Settings → "Home page intro"** — a sentence or two
introducing who the site is (a lead paragraph shown on the home page).
Leave it blank and it's simply omitted; there's no fallback to your site
description (that already appears in the masthead, so the two don't
duplicate each other).

**Featured content.** Open any post or photo post for editing (Blog or
Photos — the toggle works identically on both) and check **"Feature on the
home page"**. Featured items appear in the home page's "Selected" showcase,
newest-first. It's off by default — nothing is featured until you turn it
on somewhere.

**How the home selects and rotates featured items:**

- The showcase shows **up to four** featured items at a time (one lead
  item plus up to three supporting items).
- Four or fewer featured items: all of them show, every time, newest-first.
- More than four featured items: each page load picks a **random** subset
  of four from the full featured set, so a large featured set **rotates**
  rather than silently overflowing. The lead item is always the newest of
  that load's chosen four.
- Feature nothing, and the showcase section doesn't render at all — no
  empty box.
- A featured item with no cover image still gets a slot — it renders as a
  plain typographic card (title only) instead of an image.

Below the showcase, the home page also lists your **6 most recent**
published posts (a link to the full listing follows). This ledger isn't
gated by the featured flag — it's just "what's newest," independent of
what you've chosen to feature.

---

## Building a new module

Out of scope for this operator-facing guide. The core↔module interface (the
five registrable capabilities: routes, admin nav, content types, settings,
theme hooks) is defined by `ModuleManifest` in `app/src/lib/module/types.ts`
— the three manifests above (`app/src/modules/{blog,pages,photos}/manifest.ts`)
are worked, shipped reference implementations of it.
