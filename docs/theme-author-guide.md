# osshp — Theme Author Guide

**Audience:** contributors building a new theme (or customizing the shipped
one). Operators who just want to change colors/fonts without touching code
should use **Admin → Settings → Branding** instead (accent color, default
color scheme, heading/body font family) — that's a data change, not a theme.

This is the practical how-to and the binding contract in one place — what a
theme may and may not do, and why — pointing at the real, shipped code as
worked examples of every rule below.

**Reference implementations:**
- `app/src/themes/editorial/theme.tsx` + `app/public/themes/editorial/theme.css`
  — the full, polished default theme ("Editorial — Colophon"). Copy this as
  your starting point for a real theme.
- `app/src/themes/skeleton/theme.tsx` + `app/public/themes/skeleton/theme.css`
  — a deliberately minimal reference theme kept in the codebase as the
  simplest possible complete example (no styling opinions, every required
  render target implemented plainly). Read this first if Editorial feels
  like too much at once.

---

## What a theme is

A theme is exactly two things, and nothing else:

1. **A `ThemeManifest` object** (`app/src/lib/theme/types.ts`) — an
   `id`, `name`, `version`, a `document(ctx, shell)` function that renders
   the whole `<html>` shell, a `templates` map keyed by render target, a
   `tokenStylesheetHref` pointing at your CSS token file, and
   `schemes: ["light", "dark"]`.
2. **A token stylesheet** — CSS that sets **color and material values only**
   (backgrounds, text colors, borders, shadows) for both color schemes. It is
   loaded *after* the app's structural stylesheet, so it can't win a
   specificity fight against a structural token without `!important` — and
   using `!important` to fight a structural token is a contract violation
   (see "What you must never touch" below).

A theme never fetches data, never queries the database, never sees a secret,
and never reaches an admin API. It receives one read-only
`ThemeRenderContext` object per request and returns markup. That's the
entire interface (theme-rendering-contract §3.1) — if your theme needs
something not in that context, it's asking for something it structurally
cannot have.

## Registering a theme

Two bundled themes ship today (`app/src/lib/platform/index.ts`):

```ts
import { editorialTheme } from "@/themes/editorial/theme";
import { skeletonTheme } from "@/themes/skeleton/theme";
// ...
g.__osshpThemeRegistry = createThemeRegistry([editorialTheme, skeletonTheme]);
```

A third theme drops in by adding its `ThemeManifest` to that same array —
**zero changes to the app or to either existing theme.** This is the whole
swap seam: because every theme reads only semantic token names and the data
interface is fixed, registering a new manifest is the entire integration
step.

There is currently no admin-console "choose your theme" picker built (the
active theme is `settings.activeTheme`, resolved the same fail-safe way
module selection is — see `docs/modules.md` for the parallel gap on modules;
this is the theme-side equivalent). Selecting between the two bundled themes
today is a settings-table concern, not an admin UI concern, in v0.1.

## Render targets — what your `templates` map must cover

The app resolves each request to a **render target** and calls your
theme's matching template function with the `ThemeRenderContext`:

| Target | Renders | Required? |
| --- | --- | --- |
| `document` | the whole shell (not in `templates` — a top-level function on the manifest, see below) | **required** |
| `home` | the landing page | **required** |
| `post` | a single article or photo-post | **required** |
| `page` | an About/portfolio-style page | **required** |
| `post-list` | the paginated blog index | **required** |
| `photo-list` | the Photos module's gallery grid | optional (Photos module only) |
| `page-list` | an index of published pages | optional |
| `tag` | a tag-filtered post list | optional (falls back to `post-list`) |
| `not-found` | 404 | optional (app provides a default) |

Render targets are an **append-only enum** — adding one later is
non-breaking (a theme that doesn't implement it falls back to a default);
removing or renaming one is a breaking contract change. `document` is a
function directly on the manifest (not inside `templates`) because it needs
the extra `shell` argument described next.

## The `document` shell — what the app hands you, and what you must emit

`document(ctx, shell)` builds the entire `<html>`/`<head>`/`<body>`. The
`shell` argument carries everything you did not have to build yourself:

- `shell.scheme` — the resolved `"light" | "dark"` for this render.
- `shell.nonce` — the CSP nonce. **Any inline `<script>` or `<style>` your
  theme emits must carry this nonce** — the site runs a nonce-based Content
  Security Policy with no `'unsafe-inline'`, so an un-nonced inline tag is
  silently blocked by the browser, not an error you'll see server-side.
- `shell.noFlashScript` — an inline script string you must place in `<head>`,
  before any stylesheet or body content. It reads the visitor's persisted
  color-scheme choice and sets `data-scheme` synchronously before first
  paint, so there's no light→dark flash on load. Don't try to reimplement
  this yourself — emit it verbatim, nonce-carried, first in `<head>`.
- `shell.structuralStylesheetHref` / `shell.tokenStylesheetHref` — link tags
  for these, structural first, in that order (specificity depends on it).
- `shell.brandTokenCss` — a string of **already AA-safe** CSS custom
  property declarations (the operator's accent color, resolved to
  guaranteed-passing `--accent-solid`/`--accent-text`/`--on-accent` values,
  plus font family overrides) — nonce-carried, emit as an inline `<style>`.
  You never compute these yourself; the app runs the accessibility guardrail
  before your theme ever sees them (see "Branding" below).
- `shell.body` — the rendered output of whichever `templates` entry matched
  this request. Place it inside your `<main>`.

Editorial's `document()` (`app/src/themes/editorial/theme.tsx`, ~line 713) is
the fullest worked example — including conditionally loading the Photos
lightbox's CSS/JS only on routes that need it, and a public-site color-scheme
toggle script (also nonce-carried) that flips `data-scheme` client-side with
zero network round-trip, since both schemes' values already shipped in your
token stylesheet.

## What you own vs. what you must never touch

**You own (color/material — Layer 2 & 3):**

`--bg`, `--surface`, `--surface-sunken`, `--text`, `--text-muted`,
`--border` / `--border-strong`, `--danger-*` / `--success-*` / `--warning-*`,
`--code-tint`, `--selection`, `--shadow-sm` / `--shadow-md` — per scheme, in
your token stylesheet.

**You must never redefine (Layer 1 — structural, app-owned):** the type
scale (`--text-4xl` … `--text-2xs`), spacing (`--space-3xs` …
`--space-3xl`), radii, border widths, layout measures
(`--measure-prose`/`--measure-content`/`--measure-wide`), focus *geometry*
(`--focus-width`/`--focus-offset` — the focus *color*, `--focus`, is yours),
or motion timing. This is the rule that makes theme-swapping safe: switching
`activeTheme` must leave every computed size, radius, measure, and spacing
identical — only color and material may change. `app/public/structural.css`
is the authoritative source of every Layer-1 token name and value; read it
before styling anything, so you know which names are off-limits.

## Branding — you receive already-accessible tokens, you don't compute them

The operator picks one accent hue (any color) in **Settings → Branding**.
The app runs a deterministic contrast-guardrail on that hue **before** your
theme ever sees it, and hands you three guaranteed-passing values via
`ctx.brand` / `shell.brandTokenCss`:

- `accentSolid` — ≥3:1 against the surface (safe for a filled button/border).
- `onAccent` — auto-picked white or near-black, ≥4.5:1 on `accentSolid`
  (safe as text/icon color sitting on a solid accent fill).
- `accentText` — ≥4.5:1 against `--bg` (safe as a link/focus-ring color on
  the page background).

**Never re-derive these, never use the raw operator-supplied hue directly,
and never put an accent color on body text** — body copy always uses
`--text`/`--text-muted` (always ≥7:1), so an operator's color choice can
never make reading copy fail contrast. Editorial's Colophon theme is
deliberately accent-free everywhere *except* the focus ring
(`var(--focus, var(--ink))`) — a legitimate, contract-compliant design
choice: a theme is never required to use the accent everywhere, only to
never bypass the guardrail when it does use it.

## Content, sanitization, and slots

`ctx.content` is a discriminated union keyed to `ctx.route.kind` (post,
page, post-list, etc.) — see `ThemeContent` in
`app/src/lib/theme/types.ts`. Body HTML (`bodyHtml` on a post/page) is
**already sanitized** by the app's `unified`/`remark`/`rehype-sanitize`
pipeline before it reaches you — render it, don't re-sanitize it, and never
construct your own `dangerouslySetInnerHTML` from any other source. Only
`published` content ever reaches a theme; draft and scheduled content never
appear in `ThemeRenderContext`.

**Slots** (`ctx.slots["head.meta"]`, `ctx.slots["footer.widgets"]`, etc.) are
how modules contribute extra markup without your theme having to know they
exist. Read `ctx.slots[slotId]` (an already-sanitized, already-ordered array)
and place it wherever you want — Editorial's `<HeadSlots>` /
`<Slots items={ctx.slots["footer.widgets"]} />` (theme.tsx) are the pattern.
**`head.meta` is the one slot you must render** (SEO correctness depends on
it, e.g. Blog's RSS `<link>`); every other slot is optional.

## Accessibility — inherited automatically, but verify it

Your theme inherits an AA-passing baseline from the app-owned tokens and
guardrail — you don't have to compute contrast ratios yourself if you stick
to semantic token names throughout. What you're still responsible for:

- **Never remove or override the `:focus-visible` outline.** Every
  focusable element must show a visible ring using `--focus-width`
  (structural) and your `--focus` color (yours, ≥3:1 by construction) in
  both schemes.
- **Reflow at 320px.** No horizontal page scroll, and no content clipped
  off-screen — verify by actually resizing a browser to 320px, not just
  eyeballing a wider viewport. This is a build-time gate on the real theme,
  not a spec claim.
- **Re-measure after any token change.** If you retune a color, verify the
  pairs that use it still clear ≥4.5:1 (body text) / ≥3:1 (large text,
  boundaries, focus rings) in *both* schemes — a value that clears one
  scheme can fail the other.

## Building your own theme, step by step

1. Copy `app/src/themes/skeleton/` (or `editorial/` if you want a fuller
   starting point) to `app/src/themes/<your-theme-id>/`.
2. Copy the matching `app/public/themes/skeleton/theme.css` (or
   `editorial/theme.css`) to `app/public/themes/<your-theme-id>/theme.css`
   and rewrite the Layer-2/3 token values — leave every Layer-1 (structural)
   name completely alone.
3. Give your manifest a unique `id`, update `tokenStylesheetHref` to point at
   your new CSS file, implement (or reuse) `document()` and every required
   `templates` entry.
4. Register it in `app/src/lib/platform/index.ts`'s
   `createThemeRegistry([...])` call.
5. Verify: toggle between your theme and Editorial at the same viewport and
   confirm every Layer-1 computed value (type sizes, spacing, radii, focus
   geometry) is byte-identical — only color/material should differ. Then
   re-run the AA checks above in both color schemes and at 320px.

**Third-party theme distribution/packaging** (installing a theme without
adding it to this repo) is explicitly out of scope for v0.1. All themes
today are first-party, in-repo, and reviewed code.
