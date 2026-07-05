# osshp

**Open-Source Self-Hostable Platform.** A self-hosted personal website —
portfolio + topic-tagged blog + photos — administered through a secure
single-admin console. One install, one site, one admin: run it as your own,
own everything it holds.

Licensed **AGPL-3.0** (see `LICENSE`).

---

## What it is

- **Blog** — Markdown articles with tags, drafts, and scheduled publishing.
- **Pages** — static pages (About, Portfolio, Contact…) with per-page
  navigation placement.
- **Photos** — a lightbox photo gallery, with automatic EXIF/GPS stripping
  on upload so location metadata never leaks through a published image.
- **Passkey-primary authentication** with layered recovery (password+TOTP,
  one-time recovery codes, a local CLI break-glass path) — no email/SMS
  dependency for account recovery.
- **A theme engine** with a fixed rendering contract: swap the entire look
  of your site by registering a different theme, with zero app changes.
  Ships with one polished reference theme ("Editorial — Colophon") and one
  deliberately minimal reference theme ("Skeleton") to build against.
- **A module system**: Blog/Pages/Photos are all first-party modules built
  against the same public contract a future third-party module would use —
  "I want a blog but not a gallery" is a first-class supported choice.
- **Lossless content export/import** as portable Markdown+YAML-frontmatter,
  so nothing is ever trapped in the app, plus full-instance
  backup/restore (database + media + secrets, encrypted at rest).
- **WCAG 2.1 AA** is a build requirement for the core, both shipped
  reference themes, and every owned UI component — not an aspiration.

Every feature above is described in detail, with usage examples, in
`docs/` — see "Documentation" below.

## Tech stack

Next.js (App Router) on Bun · PostgreSQL · S3-compatible object storage
(Garage, swappable for any S3-compatible provider) · Caddy (automatic
HTTPS) · Docker Compose. Headless UI primitives from Radix, composed into
owned, vendored components — see `docs/decisions/0001-ui-primitive-radix.md`.

## Quickstart

```sh
git clone <this-repo> osshp && cd osshp
./scripts/setup.sh          # creates .env + config/garage.toml from examples
# fill in every CHANGE_ME value in .env and config/garage.toml
docker compose up -d
# provision Garage (one-time) — see docs/setup-runbook.md for the exact commands
```

Then open `https://<your-domain>` (or `https://localhost` for local
evaluation) and complete the setup wizard: create your admin passkey, name
your site, pick an accent color, choose which modules to enable.

**Full walkthrough, including the Garage provisioning commands and
troubleshooting:** [`docs/setup-runbook.md`](docs/setup-runbook.md).

### Deployment modes: direct TLS vs Cloudflare Tunnel

osshp supports two ways to expose your site. Pick by how the host is
connected:

| Your host | Mode | What happens |
| --- | --- | --- |
| **VPS, or any host you can reach on ports 80/443** (static IP / port-forwardable) | **Direct** (default) | Caddy terminates TLS in-stack with an automatic Let's Encrypt certificate. `docker compose up -d`. Nothing extra. |
| **Home network / dynamic residential IP / CGNAT / no port-forwarding** | **Cloudflare Tunnel** | `cloudflared` dials *out* to Cloudflare — no inbound ports, your home IP never appears in DNS. TLS terminates at Cloudflare's edge. |

Tunnel mode is a one-flag opt-in — `./scripts/setup.sh --mode tunnel
--tunnel-token <token>` — plus a small manual step in the Cloudflare
dashboard (create the tunnel + map the public hostname). Full walkthrough,
trade-offs, and the **passkey caveat when changing a live instance's
domain**, in [`docs/setup-runbook.md`](docs/setup-runbook.md) →
"Cloudflare Tunnel mode".

## Documentation

| Doc | Covers |
| --- | --- |
| [`docs/setup-runbook.md`](docs/setup-runbook.md) | Install: Docker Compose bring-up, secrets, Garage provisioning, the setup wizard, recovery lanes |
| [`docs/upgrade-guide.md`](docs/upgrade-guide.md) | Updating an already-running instance to a newer version |
| [`docs/backup-restore.md`](docs/backup-restore.md) | Full-instance backup/restore (database + media + secrets, encrypted) |
| [`docs/content-export-import.md`](docs/content-export-import.md) | Portable Markdown content export/import — admin console + CLI, the three re-import modes |
| [`docs/modules.md`](docs/modules.md) | What Blog/Pages/Photos each do, with usage examples; the module system in general |
| [`docs/theme-author-guide.md`](docs/theme-author-guide.md) | Building or customizing a theme |
| [`docs/dependency-update-cadence.md`](docs/dependency-update-cadence.md) | Routine dependency/base-image maintenance |
| [`CREDITS.md`](CREDITS.md) | Full third-party attribution — every adopted open-source dependency |
| [`docs/decisions/`](docs/decisions/) | Architecture Decision Records for format-freezing / hard-to-reverse choices |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contributor setup, running tests, the pre-push gate |

## License

AGPL-3.0 — see [`LICENSE`](LICENSE). Third-party attribution for every
adopted open-source dependency is in [`CREDITS.md`](CREDITS.md).
