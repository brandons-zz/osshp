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

**Shipped modules (v0.1):** Blog, Pages, Photos, Analytics. All four are
pre-checked ("enabled by default") in the setup wizard.

---

## Enabling and disabling a module

**At setup:** the setup wizard's third step ("Choose modules") lets you
uncheck any of the four before finishing setup — that's the supported way
to opt a module out from the start.

**After setup:** **Admin → Settings → Modules** has a checkbox per module
(Blog / Pages / Photos / Analytics) — check or uncheck the ones you want live, then
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

**Admin-lockout safeguard:** you can disable all four modules at once —
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

## External images in Markdown — auto-import & attribution

Applies to any Markdown body (Blog, Pages, and Photos post bodies alike).

osshp's Content-Security-Policy only allows images from your own instance
(`img-src 'self' data:`) — every visitor's page load stays entirely within
your site, with nothing loaded from a third-party host. If you paste a
Markdown image that points at an external URL —
`![a cat](https://example.com/cat.jpg)` — osshp fetches that image on save,
re-encodes it through the same pipeline a manual upload goes through
(EXIF/GPS stripped, responsive variants generated), stores it in your media
library, and rewrites the Markdown to point at the new local copy. Your post
looks the same to you; the image now lives on your own instance and keeps
working even if the original host disappears or removes it.

**If a fetch fails** (the URL times out, the host refuses the connection, the
response isn't actually an image, or the server considers the target
unsafe to fetch), the original external URL is left in your Markdown
unchanged — nothing is lost — and the save response reports which image
failed and why, so you know to upload it manually instead.

**Crediting a source:** add a caption in Markdown's title slot —
`![a cat](https://example.com/cat.jpg "Photo by Jane Doe")` — and once the
image is imported it renders as a captioned figure with a linked credit back
to the original source. **Attribution is not the same as a license.** Adding
a credit does not by itself make an image legal for you to use — you are
responsible for having the right to use any image you publish (because you
took it, it's in the public domain, its license permits your use, or you
have explicit permission). When in doubt, use your own photos or ones you've
confirmed you're licensed to use.

## Analytics

> "First-party, self-hosted pageview analytics. No third-party script, no
> cookies, no PII — everything stays in your Postgres."

**What it adds:**

- An admin dashboard at **Admin → Analytics**, with a 7 / 30 / 90-day window
  switcher: total pageviews, an estimated unique-visitor count, a
  pageviews-over-time chart + table, your top content by path, and your top
  external referrer hosts. There is no public route — Analytics has exactly
  one surface, the dashboard.
- Capture itself is **not a route you visit** — it is a side effect of the
  app server rendering any public page (home, `/blog`, `/blog/[slug]`,
  `/tags`, `/tags/[slug]`, `/pages/[slug]`, `/photos`, `/photos/[slug]`).
  Nothing runs in the visitor's browser: no beacon script, no pixel, no
  cookie, no addition to the Content-Security-Policy. Admin pages, API
  routes, and non-HTML responses (RSS, sitemap, robots.txt, media files) are
  never counted.
- No settings, no public-nav suggestion, no theme-hook contributions.

**Privacy posture (the reason this module can ship on by default):**

- **No PII is ever stored.** The recorded event row holds only the UTC
  calendar day, the page path (no query string), and the referrer's HOST
  only (never the full referrer URL, and never your own domain — internal
  navigation isn't recorded as a "referrer"). Your raw IP address and User-Agent
  string are never written to the database.
- **Unique-visitor counting is a salted, one-way hash** of
  (IP, User-Agent, UTC day). The salt **rotates once per day and is never
  persisted** — it lives in server memory for that day only, so a stored
  hash can never be reversed back to an IP/User-Agent, and the same real
  visitor on two different days produces two mathematically unrelated
  hashes. That makes the "unique visitors" figure an **estimate** by
  construction (a visitor active on 3 different days in a 30-day window
  counts 3 times) — it deliberately cannot re-identify a returning visitor
  across days, because that is exactly the tracking capability this design
  refuses to build.
- **`DNT: 1` and `Sec-GPC: 1` are honored as a hard stop:** a request
  carrying either header is not recorded at all — not anonymized, not
  logged in any reduced form, simply never looked at beyond those two
  headers.
- **Obvious bots and crawlers are filtered** by a User-Agent heuristic
  before anything is hashed or stored, so search-engine/monitoring traffic
  doesn't inflate your counts.
- **Only successful page-serves count, and stored values are bounded.** A
  404 is not a pageview — a request for a URL that doesn't exist records
  nothing, so a visitor (or script) requesting random made-up URLs can't
  fill your "top content" with junk paths. Events whose path exceeds 512
  characters or whose referrer host exceeds 253 characters (the DNS
  hostname maximum — no real hostname is longer) are **dropped entirely,
  never truncated-and-stored**; legitimate traffic never hits either bound.
  *Accepted residual (v1):* a client that fabricates unique-but-in-bounds
  `Referer` hostnames can still add junk rows to the top-referrers table —
  that's inherent to referrer analytics everywhere (the header is
  client-supplied by nature), it touches only that one report, and the
  90-day retention bounds how long any of it lives.
- **90-day retention:** recorded events older than 90 days are pruned
  automatically (an opportunistic sweep piggybacked on normal traffic — no
  separate cron/scheduler to run). Nothing is ever exported or sent
  anywhere; every number on the dashboard is computed from your own
  Postgres.
- Disabling the module stops capture **immediately** (the render path only
  records a pageview when Analytics is in the enabled-module set) and makes
  the dashboard render its "module is disabled" message instead of data —
  but, unlike Blog/Pages/Photos, there is no public route to 404: capture
  and the dashboard are Analytics' only two surfaces, and disabling simply
  turns both off. **Already-recorded history is retained, not deleted** —
  re-enabling resumes capture and shows the dashboard again immediately,
  with history intact (module-contract §5 rule 2, same guarantee as every
  other module).

**Usage example:** visit **Admin → Analytics**, pick a **7 / 30 / 90 days**
window, and read the numbers — no configuration is needed beyond leaving the
module enabled. If you'd rather not collect any usage data at all, uncheck
Analytics at **Admin → Settings → Modules**; capture and the dashboard both
go inert immediately.

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
— the four manifests above
(`app/src/modules/{blog,pages,photos,analytics}/manifest.ts`) are worked,
shipped reference implementations of it.
