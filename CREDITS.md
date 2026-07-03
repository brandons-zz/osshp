# Credits & Third-Party Attribution

osshp is distributed under **AGPL-3.0** (see `LICENSE`). It builds on open-source software
listed below. Attribution is a release blocker (spec principle 7); this file is updated in every
milestone closeout as dependencies are added. The authoritative dependency inventory (versions,
licenses, health, AGPL compatibility) is `docs/dependency-matrix.html`.

## Headless UI primitive (Layer A)

osshp's owned UI components (Layer B, in `app/src/components/ui/`) are composed on top of the
**Radix UI** headless primitive — the chosen behavior/accessibility layer (see
`docs/decisions/0001-ui-primitive-radix.md`). React Aria was the validated alternative and was
not adopted (do not mix the two).

| Package | License | Project | Copyright |
| --- | --- | --- | --- |
| `@radix-ui/react-slot` | MIT | Radix UI (WorkOS) | © WorkOS, Inc. and Radix UI contributors |

> Additional Radix primitive packages (`@radix-ui/react-dialog`, `-dropdown-menu`,
> `-navigation-menu`, `-accordion`, `-tabs`, `-tooltip`, …) are added in Phase 1 as the reference
> component inventory is built; append them here as installed.

## Application runtime

| Package | License | Project |
| --- | --- | --- |
| Next.js | MIT | Vercel |
| React / react-dom | MIT | Meta (React team) |
| Bun | MIT | Oven |

## Data layer (M1.3 content + settings core)

| Package | License | Project | Scope |
| --- | --- | --- | --- |
| `postgres` (postgres.js) | MIT | Rasmus Porsager | Production PostgreSQL client |
| `@electric-sql/pglite` | Apache-2.0 | ElectricSQL | Dev/test only — in-process PostgreSQL (WASM) for the pre-push test gate; not shipped in the app |

## Authentication — passkey ceremony

| Package | License | Project | Scope |
| --- | --- | --- | --- |
| `@simplewebauthn/server` | MIT | Matthew Miller (SimpleWebAuthn) | Server-side WebAuthn ceremony (M1.6) |
| `@simplewebauthn/browser` | MIT | Matthew Miller (SimpleWebAuthn) | Browser passkey helpers — `startRegistration` / `startAuthentication` for the setup wizard + login (M1.8) |

## Content rendering — sanitization boundary

| Package | License | Project | Scope |
| --- | --- | --- | --- |
| `unified` / `remark-parse` / `remark-rehype` / `rehype-parse` / `rehype-sanitize` / `rehype-stringify` | MIT | unified collective | App-owned Markdown→sanitized-HTML + HTML-fragment sanitization (theme/module output, M1.4) |

## Typography — self-hosted fonts (Editorial "Colophon" reference theme)

The default Editorial theme self-hosts its two typefaces as woff2 (latin + latin-ext
subsets) under `app/public/themes/editorial/fonts/`, served same-origin (no external
font CDN; declared via `@font-face` in `app/public/themes/editorial/theme.css`). Both
are licensed under the SIL Open Font License 1.1 (AGPL-compatible).

| Font | License | Designer / Foundry | Copyright |
| --- | --- | --- | --- |
| IBM Plex Mono | SIL OFL 1.1 | IBM (Mike Abbink, Bold Monday) | © IBM Corp. — furniture: nav, meta, labels, ledger index, plate numbers, code, footer |
| Newsreader | SIL OFL 1.1 | Production Type (Nathan Willis / Cyrus Highsmith) | © The Newsreader Project Authors — reading: headings, body, pull-quotes |

## Image processing (M2.7 media pipeline)

| Package | License | Project | Scope |
| --- | --- | --- | --- |
| `sharp` | Apache-2.0 (libvips: LGPL-2.1+ via dynamic link) | Lovell Fuller / sharp contributors | Responsive image resize + EXIF/GPS strip — `app/src/lib/media/processor.ts` (M2.7) |

## Object storage client

| Package | License | Project | Scope |
| --- | --- | --- | --- |
| `minio` | Apache-2.0 | MinIO, Inc. | S3-compatible object storage client — talks to Garage in production; the client is storage-provider-agnostic, so swapping Garage for a real S3 endpoint requires no app-code change (`app/src/lib/media/storage.ts`) |

## Media upload UI

| Package | License | Project | Scope |
| --- | --- | --- | --- |
| `@uppy/core` | MIT | Transloadit | Browser file-upload state machine — admin cover-image / photo upload UI |
| `@uppy/xhr-upload` | MIT | Transloadit | XHR upload plugin for Uppy — posts to the app's own upload routes (no third-party upload service) |

## Content editing (M2.8 admin editor)

| Package | License | Project | Scope |
| --- | --- | --- | --- |
| `@tiptap/core`, `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-document` | MIT | ueberdosis (TipTap) | Admin console Markdown source editor + live preview — configured as a single-`codeBlock` source editor (not WYSIWYG), so `getJSON()` yields the raw Markdown verbatim with no lossy JSON↔Markdown round-trip. **Only the MIT-licensed open-source TipTap packages above are used — no TipTap Cloud / Collaboration paid extensions.** A pre-push CI check (`scripts/check-tiptap-cloud.sh`) guards against ever adding one. |

## Syntax highlighting

| Package | License | Project | Scope |
| --- | --- | --- | --- |
| `shiki`, `@shikijs/langs`, `@shikijs/themes` | MIT | Shiki contributors (Pine Wu et al.) | Server-side code-block syntax highlighting in rendered post/page bodies — runs synchronously via `createHighlighterCoreSync` so the app's Markdown pipeline stays sync; output is class-based (no inline `style=` attributes), keeping it compatible with the app's nonce-based CSP (no `'unsafe-inline'`) |

## Two-factor recovery lane

| Package | License | Project | Scope |
| --- | --- | --- | --- |
| `otplib` | MIT | Yeojz (otplib) | TOTP generation/verification for the password+TOTP recovery lane (`app/src/lib/auth/totp.ts`) — pure-JS crypto plugin (no native `node:crypto` dependency), so it runs identically in route handlers and tests |

## Photo lightbox (M2.11 Photos module; first-party since M2.14)

The public Photos grid (`/photos`) opens images in a first-party, zero-dependency
vanilla-JS lightbox at `app/public/vendor/lightbox/` (`lightbox.js` + `lightbox.css`),
loaded by the theme only on the Photos route, nonce-carried under the CSP. No
third-party attribution required.

GLightbox (MIT, Biati Digital) was the original choice at M2.11 but was removed at
M2.14: it applied positioning/animation styles via `setAttribute("style", …)`, which
the app's nonce-based CSP (`style-src 'self' 'nonce-…'`, no `'unsafe-inline'`) governs
and which threw `style-src-attr` violations on every lightbox open. The first-party
replacement carries all visual state via CSS classes and element properties (never an
inline style attribute), so it is CSP-strict by construction.

## Backup & restore tooling (M4.1A)

`scripts/backup.sh` / `scripts/restore.sh` are osshp-authored; they shell out to two
host tools not otherwise used by the application, both invoked directly (not
bundled/vendored, not part of the Docker image):

| Tool | License | Project | Scope |
| --- | --- | --- | --- |
| `age` | BSD-3-Clause | Filippo Valsorda et al. (FiloSottile/age) | Passphrase-mode authenticated encryption (AEAD) of the full-site backup archive — replaced AES-256-CBC + a separate HMAC sidecar 2026-07-02, closing an argv-exposed derived-key finding |
| `expect` | Permissive (Tcl/Tk-derived) | Don Libes / Tcl community | Drives `age`'s terminal-only passphrase prompt through a real pty for non-interactive (cron/scripted-DR) runs only — `scripts/lib/age-pty.exp`; not needed for interactive use |

See `docs/backup-restore.md` for the full design writeup (why passphrase mode over
a key file, the delivery-channel guarantees, and the verified restore round-trip).

## Infrastructure (Docker Compose)

| Component | License | Project |
| --- | --- | --- |
| Caddy | Apache-2.0 | Caddy / ZeroSSL |
| PostgreSQL | PostgreSQL License | PostgreSQL Global Development Group |
| Garage | AGPL-3.0 | Deuxfleurs |

The full MIT/Apache-2.0 license texts are reproduced in each package's `node_modules` entry and
are redistributed with the source per their terms.
