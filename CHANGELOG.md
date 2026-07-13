# Changelog

All notable changes to osshp are documented in this file. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/); versioning follows
[Semantic Versioning](https://semver.org/) once the API/contract surface
stabilizes (pre-1.0, breaking changes may land in minor releases).

## [0.5.1] — 2026-07-12

Patch release fixing client-IP attribution for Cloudflare-Tunnel deployments
(no schema change; upgrade is an image swap). Includes everything in 0.5.0.

### Fixed

- **Client-IP attribution in Cloudflare-Tunnel mode** — behind a Cloudflare
  Tunnel, Caddy discards the inbound `X-Forwarded-For` and rewrites
  cloudflared's peer IP, so no hop count could recover the real client IP;
  every request resolved to no IP at all. The instance can now be told to trust
  a specific client-IP header (`OSSHP_TRUSTED_CLIENT_IP_HEADER`, set to
  `cf-connecting-ip` for tunnel deployments), which Cloudflare populates
  authoritatively at its edge. This restores the real client IP end-to-end —
  the Security Center no longer shows "IP not recorded", and per-client
  rate-limiting and analytics attribution work again. The trusted header is
  read fail-closed (no fallback to spoofable forwarded headers) and only from
  operator/deploy-time configuration, never sniffed from the request; the
  resolved value is IP-shape-validated at the source, so a malformed or
  spoofed value is dropped rather than attributed or echoed.

## [0.5.0] — 2026-07-12

Minor release layering three admin-console improvements over 0.4.1 (no schema
change; upgrade is an image swap). Includes everything in 0.4.1.

### Added

- **Security Center IP visibility** — the Security Center now shows a labeled IP
  address on each active session and on each security event, so an operator can
  see where a session or event originated at a glance. Sessions and events
  recorded before IP capture existed render an explicit "not recorded" state
  rather than a blank, so the absence is unambiguous.
- **Tag management** — the post editor gains a tag selector with autocomplete
  over existing tags and inline creation of new ones, and a new `/admin/tags`
  screen lets the operator rename, merge, and delete tags across the site. Tags
  reuse the existing data model; no migration is required.

### Changed

- **Admin design refresh** — a polished, consistent component system across the
  admin area (buttons, form controls, status pills, list/table surfaces, and
  reorder controls), replacing the earlier unstyled and inconsistent chrome
  with refined components while preserving the neutral admin shell and WCAG 2.1
  AA conformance.

## [0.4.1] — 2026-07-11

Patch release hardening the 0.4.0 security-notification egress and fixing a
latent Cloudflare-Tunnel deployment gap. Includes everything in 0.4.0.

### Security

- **Notification egress IP validation** — a security notification's Source IP
  field is now emitted only when the recorded value is IP-shaped (validated
  via `node:net`); under a misconfigured trusted-proxy hop count the field is
  omitted rather than echoing arbitrary forwarded text. Egress-boundary only —
  rate-limit/analytics keying is unchanged.
- **Array-recursive secret redaction** — the audit/notification redactor now
  recurses into arrays, so a secret-bearing object nested inside an array is
  redacted (defense in depth; no current writer is affected).
- **Self-notification-loop guidance** — added an operator note (security notes
  + `.env.example`) warning against pointing the notification webhook at the
  instance's own auth endpoints; lockout coalescing bounds the worst case.

### Fixed

- **Notification env vars now reach the container** — the app service's Compose
  environment allowlist was missing the four notification variables
  (`OSSHP_PUSHOVER_TOKEN`/`OSSHP_PUSHOVER_USER_KEY`,
  `OSSHP_WEBHOOK_URL`/`OSSHP_WEBHOOK_SECRET`), so an operator's `.env`
  settings never took effect and notifications silently stayed off; they are
  now forwarded.
- **Tunnel-mode client-IP attribution (070)** — `OSSHP_TRUSTED_PROXY_HOPS`
  (plus `OSSHP_RP_NAME` and `SESSION_IDLE_MS`) are now forwarded into the app
  container. In Cloudflare Tunnel mode `setup.sh` writes a hop count of 2, but
  no Compose file passed it through, so per-client rate limiting and analytics
  collapsed every tunnel visitor to a single key; the real client IP is now
  attributed correctly.

## [0.4.0] — 2026-07-10

Fourth release, the Security Center release. Gives the admin visibility into
and control over their own account's security state, and adds an optional
outbound alerting channel for security-relevant events. Includes everything
in 0.3.0.

### Added

- **Security Center (Slice 2)** — a new `/admin/security` admin surface:
  - **Sessions & devices** — lists active sessions with device/IP metadata
    captured at issuance, and lets the admin revoke an individual
    non-current session (step-up-gated; see below).
  - **Audit-backed events feed** — a durable, bounded audit event store
    (Postgres) backing a paginated events feed on the security page, replacing
    the prior in-memory/ephemeral view.
  - **Recovery-code status** — shows remaining recovery-code count without
    exposing the codes themselves, so the admin can tell when to regenerate.
  - **Step-up-gated revoke-all** — revoking every other session (evicting a
    suspected session thief) requires a fresh step-up re-authentication grant,
    consistent with the A1 step-up model for other credential-affecting
    actions.
- **Security notifications** — vendor-neutral outbound alerting for
  security-relevant events (credential changes, recovery use, break-glass,
  lockouts, session revocations), dispatched off the same audit choke point
  that writes the durable event store so no writer can bypass it. Two
  built-in channels, both opt-in via deploy-time environment variables only
  (never admin-UI-configurable, so a compromised session can't silence its
  own alarm):
  - A vendor-neutral webhook (plain JSON POST, optional HMAC-SHA256 body
    signature).
  - A Pushover preset.

### Fixed

- **Admin input border contrast (WCAG 1.4.11)** — the global admin form
  input border now uses a token that clears the 3:1 non-text contrast floor
  against the input fill, closing a below-threshold border on every admin
  form (including the new Security Center step-up fallback inputs).

## [0.3.0] — 2026-07-10

Third release. Closes the gap between the published GHCR image and `main`
(issue 079), and lands a round of Slice 1 account-security hardening.

### Added

- **Default brand favicon** — a full favicon/icon set (ICO, PNG, SVG) ships
  as the platform default, replacing the prior unbranded state.
- **Step-up re-authentication (A1)** — admin actions that change credentials
  (password, TOTP enrollment, recovery codes, passkeys) now require a fresh,
  single-use, factor-bound re-auth grant minted just before the change,
  independent of the ambient session. Wired into the admin account/security
  UI.
- **Durable auth-throttle persistence (A2)** — the auth rate limiter's
  window/count state now persists in Postgres (`rate_limit_windows`,
  migration `0013`) instead of in-process memory, so throttling survives a
  restart and is correct across multiple app instances. The check-and-increment
  is a single atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`,
  closing a TOCTOU race present in an earlier two-step read/write version.

### Fixed

- **Protocol-relative URL validator bypass (078)** — `isSafeUrl`/`isSafeHref`
  now reject `//host` and `/\host` forms before the single-leading-slash
  same-site allowance, closing a silent-external-redirect gap in any
  settings field rendered as an anchor or image src.

### Engineering

- **Production/test `tsconfig` split + typecheck release gate** — `tsc --noEmit`
  now runs against production sources only (`tsconfig.json`, excluding
  `**/*.test.ts(x)` and `__tests__/**`), with a separate `tsconfig.test.json`
  for test files. The production typecheck is a required, trustworthy
  pre-push gate step, independent of `next build`'s internal type-check.

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
