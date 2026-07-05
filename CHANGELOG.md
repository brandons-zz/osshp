# Changelog

All notable changes to osshp are documented in this file. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/); versioning follows
[Semantic Versioning](https://semver.org/) once the API/contract surface
stabilizes (pre-1.0, breaking changes may land in minor releases).

## [0.2.0] — 2026-07-05

Second release. Adds the first-party analytics module, gallery portability,
and a round of security hardening.

### Added

- **Analytics module** — first-party, self-hosted, privacy-first pageview
  analytics. Server-side capture (no client script, no cookies), honors DNT
  and Global Privacy Control, no PII at rest (daily-rotating, never-persisted
  visitor-hash salt), 90-day retention, `/admin/analytics` dashboard.
  Toggleable like the other first-party modules. Disabled by default on
  upgrade.
- **Auto-import of external inline images** — an external image URL in a post
  body is fetched through a hardened SSRF boundary, stored in the media
  library, and rewritten to a same-origin URL, with source/attribution/license
  recorded and rendered as a caption credit. Keeps the strict image CSP intact
  and makes posts survive the original host going away.
- **Gallery portability** — gallery membership (images, order, captions, cover)
  now round-trips through content export/import.

### Security & reliability

- Cloudflare Tunnel mode: dedicated edge network isolating the tunnel connector
  to the proxy; Docker Compose version-floor assert; correct trusted-proxy hop
  count so per-client rate limiting and analytics work behind the tunnel.
- Per-ceremony WebAuthn login challenges (an unauthenticated caller can no
  longer clobber an in-flight admin sign-in).
- Content-type ownership enforced across blog/photos routes; content import
  respects module-enable state; disabled-module content no longer surfaces on
  public listings/feeds.
- Application container runs as a non-root user; bounded title/slug length;
  malformed scheme cookie no longer errors public pages; backup verified on
  linux/amd64.

## [0.1.0] — 2026-07-02

First tagged release. AGPL-3.0. This is the Phase 1 platform: a
self-hostable personal website (portfolio + topic-tagged blog + photos)
administered through a secure single-admin console, plus the release
mechanics (backup, export/import, documentation) needed to run it in
production and keep it running.

### Added

**Core platform**
- Docker Compose stack (app / db / storage / proxy) — clone, configure
  `.env`, `docker compose up`, no code changes required to go from local
  dev to a real domain.
- Postgres 17 content/settings store with idempotent auto-migrations on
  every boot (no separate migration-runner step).
- S3-compatible object storage (Garage) for media, fronted by a Caddy
  reverse proxy that terminates TLS automatically (Let's Encrypt on a real
  domain; internal CA for local `localhost` dev).

**Authentication & account security**
- Passkey-primary authentication (WebAuthn/SimpleWebAuthn), single-admin
  bootstrap via a one-time setup wizard.
- Layered account recovery: password + TOTP second factor, one-time
  recovery codes, and a local-only CLI break-glass path
  (`docker compose exec app ./admin-break-glass`) for total lockout.
- Default-deny route access (fail-closed unless explicitly marked public),
  first-party signed sessions with idle-timeout and periodic garbage
  collection, CSRF guard on all mutating requests, boot-time strength
  floors on `SESSION_SECRET`/`OSSHP_ENCRYPTION_KEY` (weak secrets fail
  closed — the app serves 500s rather than running insecurely), and a
  trusted-proxy-aware rate limiter with an IP-independent global fallback
  cap on auth endpoints.
- Security headers + nonce-based CSP on every response; `docker-compose.dev.yml`
  is a deliberately non-auto-merging opt-in for local plain-HTTP dev, so a
  default `docker compose up` is always the hardened production posture.

**Content modules (Blog, Pages, Photos)** — each independently toggleable
from the setup wizard admin module registry:
- **Blog** — Markdown posts (TipTap source editor + live preview, Shiki
  syntax highlighting), tags, drafts, scheduled publishing, RSS 2.0 feed,
  per-post SEO metadata (canonical URL, Open Graph tags), sitemap/robots.txt.
- **Pages** — static pages with structured, drag-orderable navigation
  placement; a `/pages` index.
- **Photos** — an EXIF/GPS-stripping upload pipeline (responsive image
  variants generated server-side; raw upload bytes are never stored) and a
  CSP-strict, dependency-free lightbox gallery.
- Admin module enable/disable UI (issue 027) — toggle any of the three
  first-party modules after initial setup, not just at bootstrap.

**Editorial "Colophon" reference theme**
- A full-bleed, typographically-led public theme (self-hosted fonts, zero
  external requests) shipped as the live default, plus a deliberately
  minimal "Skeleton" reference theme to build new themes against.
- Home page featured showcase: an operator-curated "Selected" section
  (up to 4 posts/pages marked featured) plus an optional intro deck,
  above the standard recent-content ledger.
- WCAG 2.1 AA verified across both color schemes (light/dark) and at
  320px/390px reflow.

**Admin console UX**
- Photo upload with drag-and-drop dropzone, Markdown help panel, and
  confirm-dialog affordances for destructive actions.
- Settings panel (site identity, brand accent color, social links) with
  input validation hardened against injection into the public-render
  boundary.

**Full-site backup & restore**
- `scripts/backup.sh` / `scripts/restore.sh` — a single `age`-encrypted
  (passphrase mode, AEAD) archive covering Postgres content, Garage media,
  and the operator's own `.env`/`config/garage.toml` (secrets travel with
  the backup on purpose: `OSSHP_ENCRYPTION_KEY` must round-trip with the
  data it decrypts). Streamed (no plaintext ever touches disk); tamper or
  wrong-passphrase detected in a dedicated pre-extraction verify pass,
  before any destructive restore step. No separate integrity sidecar and
  no secret — passphrase or derived key — ever appears on any process's
  command line, including in non-interactive cron/DR runs.

**Content export & import**
- Lossless content export as one Markdown file per post/page with complete
  frontmatter, usable standalone (issue 001).
- Content import — single file or bulk archive — with tag mapping, media
  ingestion, link rewriting, and an explicit
  created/skipped-with-reason/errored results report; hardened against
  zip-slip/path-traversal and frontmatter-injection on untrusted archives
  (issue 002).
- Both available from the admin console and as headless CLI commands
  (`docker compose exec app ./export-content`, `./import-content`) for
  scripted backup/migration workflows.

**Documentation**
- Install/setup runbook, upgrade guide, backup/restore guide,
  content-export/import guide, per-module how-to guide, theme-author
  guide, dependency-update cadence, and a full dependency/attribution
  matrix (`docs/dependency-matrix.html`, `CREDITS.md`).
- `README.md` and `CONTRIBUTING.md` at the repo root.

### Security

- Every release-blocking security surface — auth core, platform/CSP, media
  privacy, fidelity, QA/AA — was independently reviewed before shipping.
- Backup confidentiality hardened post-gate: streamed encryption (no
  intermediate plaintext archive), closing finding V-1 from the initial
  backup security gate.
- Backup encryption subsequently switched from AES-256-CBC + a separate
  encrypt-then-HMAC sidecar to `age` passphrase-mode AEAD, closing finding
  V-2 (tamper detection is now a dedicated pre-extraction verify pass) and
  the multi-tenant-host residual noted in the initial gate: there is no
  longer a derived key of any kind to appear on process listings — verified
  live via repeated `ps` sampling during real encrypt/decrypt runs.

### Known limitations (tracked, not release-blocking)

- No in-app "About/version" page yet — the deployed git commit is the
  version record until one ships (`docs/upgrade-guide.md`).
- Home page featured showcase does not yet respect per-module
  enable/disable state (issue 028, logged as a fast-follow at feature
  freeze) — disabling a module can leave a stale link to it in the
  showcase until that module's content is also excluded from selection.
- No zero-downtime upgrade path for the `app` service (single-digit-second
  interruption during `docker compose up -d --build app`); `db`/`storage`
  stay up throughout.
- Publishing to a container registry, making the source repository public,
  and standing up the osshp.com showcase site are deliberately **not**
  part of this release — they are owner-gated decisions exercised after
  v0.1.0 is verified locally (see the M4 release plan).

[0.1.0]: https://github.com/OWNER/osshp/releases/tag/v0.1.0
