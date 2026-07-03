# Editorial "Colophon" theme — implementation + runtime verification note

**Date:** 2026-06-30

The owner-approved **"Colophon"** design is the live default Editorial theme,
replacing the previous "Editorial Clarity" look while keeping the theme-contract
architecture (ThemeManifest, public-only render context, Layer-1 structural tokens,
Layer-3 brand tokens).

## What changed
- `osshp/app/src/themes/editorial/theme.tsx` — Colophon markup for every surface:
  masthead (mono runline + ink regmark wordmark + mono nav + scheme toggle), serif
  home hero + spec line, the **mono ledger-table** writing index (post-list/tag/home),
  article with a mono spec block + serif-italic pull-quote + sunken code well + mono
  folio, page, and the numbered **grayscale photo plates** grid (lightbox hooks kept).
- `osshp/app/public/themes/editorial/theme.css` — self-contained Colophon token sheet:
  own color tokens (`--paper/--ink/--ink-muted/--ink-soft/--rule/--rule-strong/…`,
  light + dark), `--serif`/`--mono` roles, all class styling, and the self-hosted
  `@font-face` block. Does NOT redefine any Layer-1 structural token.
- `osshp/app/public/themes/editorial/fonts/*.woff2` — 16 self-hosted OFL woff2 files
  (IBM Plex Mono 400/500/600 + 400-italic; Newsreader 400/500/600 + 400-italic; latin +
  latin-ext subsets). **No external font CDN.** Attributed in `osshp/CREDITS.md`.

## Design fidelity (matches the approved prototype)
- **Mono furniture + serif reading:** IBM Plex Mono on all chrome/meta/labels/ledger/
  plate numbers/code/footer; Newsreader on headings, body, and pull-quotes.
- **Zero chromatic accent** by default; cool-grey paper (`#F3F4F6`) light / cool
  near-black (`#15161A`) dark; hierarchy via weight/space + mono/serif contrast.
- Ledger-table index (Nº · serif title + mono tags · right-aligned ISO date), grayscale
  plates, no gratuitous dividers (hairline register rules used sparingly).

## Runtime verification (live Chromium on the real theme.css + real woff2)
Rendered every surface through `renderPage` for both schemes and served the real
assets; verified in headless Chromium:
- **Fonts self-hosted:** `document.fonts.check` true for both "Newsreader" and "IBM Plex
  Mono"; computed font-family = Newsreader on body/titles, IBM Plex Mono on nav/meta;
  **zero requests to gstatic/googleapis** (external font requests = 0).
- **AA both schemes** (measured, text vs paper): light — title 15.83, nav 7.55, meta 5.13,
  register 15.83; dark — title 14.89, nav 7.79, meta 5.24, register 14.89. All ≥ 4.5:1.
- **320px reflow:** `scrollWidth == innerWidth` (no horizontal page scroll) on home,
  index, article, and photos. The only element exceeding the viewport is `<code>` inside
  `.prose pre { overflow-x:auto }` — it scrolls within its own well; the page does not.
- **CSP-clean:** the theme emits no un-nonced inline `<script>`/`<style>` (unit-verified);
  `font-src 'self'` already permits the self-hosted woff2. `bun run build` (production
  standalone artifact) compiles clean; full `bun test src/` = 313 pass / 0 fail.

## Operator-accent reconciliation
The theme is **accent-free on all at-rest surfaces** (body, headings, furniture, ledger,
plates, nav-at-rest, links, footer are pure ink — fidelity to the prototype). The branding
pipeline is untouched: the app still injects `--focus`/`--accent-text`/`--accent-solid`
(runtime-confirmed injected as the operator value), and the theme **leaves them intact**,
honoring an operator-set accent only on the transient `:focus-visible` ring
(`outline-color: var(--focus, var(--ink))`, AA-guaranteed via `--accent-text`, falls back
to ink when no accent). Keyboard focus therefore reflects operator branding without
tinting the reading surface; the accent-free default is correct.

One deliberate contract choice to note for anyone re-verifying this theme: the
focus-visible ring uses the operator `--focus` (accent) rather than hardcoded ink, so
branding is honored; every at-rest surface is pure ink and pixel-faithful. On
re-measuring AA in either scheme, the tightest light-scheme pairings to check first
are `--ink-soft` on `--sunken` (4.65:1) and `--rule-strong` on `--paper` (3.35:1).
