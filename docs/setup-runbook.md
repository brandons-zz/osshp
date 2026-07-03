# osshp — Setup Runbook (Install Guide)

**Audience:** operators standing up a new osshp instance.

This is the first-run install path: bring up the Docker Compose stack, provision
object storage, and complete the setup wizard to get a working, secured
single-admin site. For updating an existing instance see
`docs/upgrade-guide.md`; for taking backups see `docs/backup-restore.md`.

---

## What you need before you start

- A Docker host with **Docker Compose v2** (`docker compose`, not the standalone
  `docker-compose` v1 binary).
- A domain name pointed at the host (production), **or** just use `localhost`
  for local evaluation/dev — both are supported the same way.
- Ports **80** and **443** free on the host (Caddy needs them for automatic
  HTTPS; override via `HTTP_PORT`/`HTTPS_PORT` in `.env` if they're taken).
- `openssl` on your local machine (used to generate secrets below — any recent
  version works).

osshp runs as four containers: **app** (Next.js/Bun), **db** (Postgres 17),
**storage** (Garage — S3-compatible object storage), **proxy** (Caddy, TLS
termination). All four are defined in `docker-compose.yml`; nothing else needs
to be installed on the host.

---

## 1. Clone and run first-time setup

```sh
git clone <this-repo> osshp && cd osshp
./scripts/setup.sh
```

`setup.sh` copies `.env.example` → `.env` and `config/garage.toml.example` →
`config/garage.toml` if they don't already exist, then tells you exactly which
`CHANGE_ME` values to fill in. It does not start anything.

## 2. Fill in `.env`

Open `.env` and generate a real value for every `CHANGE_ME`:

| Variable | Purpose | Generate with |
| --- | --- | --- |
| `OSSHP_DOMAIN` | Domain Caddy serves (or `localhost` for local dev) | — (you choose) |
| `OSSHP_RP_ID` | WebAuthn Relying Party ID — **domain only**, no scheme/port (e.g. `example.com`) | — (matches `OSSHP_DOMAIN`) |
| `OSSHP_ORIGIN` | Full expected origin, incl. scheme (e.g. `https://example.com`) | — |
| `SESSION_SECRET` | Signs session cookies | `openssl rand -hex 32` |
| `OSSHP_ENCRYPTION_KEY` | AES-256-GCM key that encrypts TOTP secrets at rest | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | Postgres password (also update the matching value inside `DATABASE_URL`) | `openssl rand -hex 24` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Garage credentials the app uses | filled in during Garage provisioning, step 4 below |

**Use `-hex`, not `-base64`, for any secret that goes inside a URL.**
`POSTGRES_PASSWORD` gets substituted directly into `DATABASE_URL`
(`postgresql://osshp:<password>@db:5432/osshp`), and `openssl rand -base64`
output can contain `/` and `+` — either one breaks URL parsing wherever the
password lands (a `/` is read as a path separator). `openssl rand -hex 24`
produces a same-strength, URL-safe value with no such risk, matching
`SESSION_SECRET` and `OSSHP_ENCRYPTION_KEY` above. After generating it, copy
the **same** value into both `POSTGRES_PASSWORD` and the `CHANGE_ME` in
`DATABASE_URL` — they must match exactly.

**Why `OSSHP_RP_ID` / `OSSHP_ORIGIN` matter:** these are pinned from your
config and are **never** derived from a request's `Host` header — this is a
deliberate security decision (ADR 0002, decision 4), the same class of bug
class as trusting `X-Forwarded-Host`. Get them right for your real domain
before going live; changing `OSSHP_RP_ID` later invalidates every existing
passkey (WebAuthn ties credentials to the RP ID).

### Secret-strength requirement (fail-closed at boot)

`SESSION_SECRET` and, if set, `OSSHP_ENCRYPTION_KEY` are checked against a
strength floor (length + entropy, rejects known placeholder/example values
like `CHANGE_ME` or a copy-pasted sample) the moment the app boots. **A weak
secret does not crash the process** — it fails closed: the app stays up but
serves HTTP 500 on every request, including its own healthcheck, so
`docker compose ps` will show the `app` service as `Up (unhealthy)` rather
than a crash-loop. If you see that, re-generate the offending secret with
`openssl rand -hex 32`, update `.env`, and `docker compose up -d --force-recreate app`.

`OSSHP_ENCRYPTION_KEY` is **optional at boot** (TOTP is opt-in — see
"Recovery lanes" below) but becomes mandatory the moment an operator tries to
enroll TOTP; leaving it unset until then is fine.

## 3. Fill in `config/garage.toml`

Set `rpc_secret` to a fresh 64-character hex string:

```sh
openssl rand -hex 32
```

Paste the output over `CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32` in
`config/garage.toml`. Everything else in that file is a sane single-node
default (see the comments in the file if you're deploying multi-node — out of
scope for a single self-host).

## 4. Bring the stack up and provision object storage

```sh
docker compose up -d
docker compose ps       # db and storage should be Up/healthy quickly; app
                         # will report unhealthy until Garage is provisioned
                         # AND the S3 keys below are in .env
```

Garage needs a **one-time** provisioning step after its first boot — it has
no bucket, key, or storage layout until you create them:

```sh
# 1. Find this node's ID
docker exec osshp-storage-1 /garage status
#    → copy the node ID shown (a long hex string)

# 2. Assign it to a storage layout (single-node: one zone, one capacity)
docker exec osshp-storage-1 /garage layout assign -z dc1 -c 1G <node-id>
docker exec osshp-storage-1 /garage layout apply --version 1

# 3. Create the media bucket and an app access key
docker exec osshp-storage-1 /garage bucket create osshp-media
docker exec osshp-storage-1 /garage key create osshp-app-key

# 4. Grant that key read/write/owner on the bucket
#    (KEY-ID below is printed by `garage key create` above, e.g. GK...)
docker exec osshp-storage-1 /garage bucket allow --read --write --owner osshp-media --key <KEY-ID>
```

`garage key create` prints the key's ID **and secret together, once, at
creation time** — copy both immediately from that command's terminal
output before doing anything else. If you lose the secret before saving it,
the safe recovery is `garage key delete <key-id>` and repeating steps 3-4
with a fresh key rather than trying to recover the old secret.

Copy the key ID into `S3_ACCESS_KEY` and the secret into `S3_SECRET_KEY` in
`.env`, then restart the app so it picks them up:

```sh
docker compose up -d --force-recreate app
docker compose ps       # app should now report Up (healthy) within ~15-30s
```

If `app` stays unhealthy after this, check `docker compose logs app` — the
usual causes are a weak/missing secret (see above) or a `DATABASE_URL`
password that doesn't match `POSTGRES_PASSWORD`.

## 5. Open the site and complete the setup wizard

Browse to `https://<OSSHP_DOMAIN>` — you'll be redirected to `/setup`.

**Certificate note (local dev only):** if `OSSHP_DOMAIN=localhost`, Caddy
issues a certificate from its internal CA, so your browser will show a
warning. Click through it ("Advanced → Proceed" / "Accept the Risk") — this
is expected for local HTTPS and is not a problem with a real domain, where
Caddy obtains a real Let's Encrypt certificate automatically (ports 80/443
must be reachable from the internet for that).

The setup wizard has three steps, and **it can only be completed once**:

1. **Create your administrator passkey.** osshp is single-admin — there is
   exactly one account, created here. Your browser will prompt for a passkey
   (Touch ID, Windows Hello, a security key, or your OS/browser's password
   manager, depending on what you have available). This step is a real
   WebAuthn registration ceremony; once the admin row exists, this bootstrap
   path closes permanently — any further credential enrollment requires
   being logged in first (see "Recovery lanes" below for what to do if you
   ever lose this passkey).
2. **Name & brand.** Site title (required), an optional description, and an
   accent color (any hue you like — pick with the color swatch). osshp
   automatically derives AA-accessible text/button colors from whatever hue
   you choose; there's no way to pick an inaccessible combination.
3. **Choose modules.** Toggle which first-party features are active: **Blog**,
   **Pages**, and **Photos** are all pre-checked (see `docs/modules.md` for
   what each one does). This isn't a one-time choice — you can change it
   later from **Admin → Settings → Modules** once you're set up
   (`docs/modules.md` covers what enabling/disabling actually does).

Finishing the wizard takes you to `/admin`.

## 6. Sign in day-to-day

`/login` — sign in with your passkey. If you're locked out (lost device,
browser reset, moved to a new machine with no synced passkey), see
"Recovery lanes" below and `/login/recovery`.

## Recovery lanes (set these up before you need them)

osshp layers three recovery options beyond the primary passkey, all managed
from **Admin → Account → Security** (`/admin/account/security`) once you're
logged in:

1. **Password + TOTP.** Set a password (12+ characters) and enroll a TOTP
   authenticator app (Google Authenticator, 1Password, etc. — any standard
   TOTP app). This is a genuine two-factor recovery lane: the password alone
   is never sufficient, TOTP is required alongside it. `OSSHP_ENCRYPTION_KEY`
   (see step 2) must be set before you can enroll TOTP — the app refuses to
   store a TOTP secret unencrypted.
2. **Recovery codes.** One-time-use codes generated from the same panel,
   shown **once** at generation time — save them somewhere safe immediately
   (a password manager, not a note next to this server). Each code logs you
   in once and is then invalidated.
3. **CLI break-glass** (`docs/backup-restore.md`-adjacent, but distinct from
   backup/restore): if you're locked out of all of the above — lost passkey,
   lost password, lost recovery codes — run this **on the host**, as the
   operator who controls the container (there is deliberately no network
   route to this; if you can run this, auth is already moot):

   ```sh
   docker compose exec app ./admin-break-glass
   ```

   This revokes every existing session, invalidates the old recovery-code
   set, opens a short window to register a fresh passkey via the login
   screen's recovery flow, and prints a brand-new set of recovery codes
   **once** to your terminal — copy them immediately, they are never shown
   again.

## Local plain-HTTP development

The default `docker compose up` (no extra flags) is always the secure
production posture — Secure cookies, Caddy TLS, no bypass port. For local
development over plain `http://localhost` without a browser certificate
warning, use the tracked dev overlay explicitly:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

Compose does **not** auto-merge this file (its filename is deliberately not
`docker-compose.override.yml` — see the comment at the top of
`docker-compose.yml` for why: an auto-merged override file previously caused
a silent security downgrade, issue 022). Don't create a file literally named
`docker-compose.override.yml` in this repo.

## Troubleshooting quick reference

| Symptom | Likely cause |
| --- | --- |
| `app` container stuck `Up (unhealthy)` | Weak/placeholder `SESSION_SECRET` or `OSSHP_ENCRYPTION_KEY` — the app is fail-closed-serving 500s, not crashed. Regenerate and `--force-recreate app`. |
| `app` never becomes healthy, logs show a DB connection error | `DATABASE_URL`'s password doesn't match `POSTGRES_PASSWORD` in `.env`. |
| `app` container unhealthy on first boot, logs show `ERR_INVALID_URL` or a malformed `DATABASE_URL` | `POSTGRES_PASSWORD` (or the copy of it inside `DATABASE_URL`) contains a URL special character like `/` or `+` — usually left over from a `base64`-generated password. Regenerate with `openssl rand -hex 24`, update **both** `POSTGRES_PASSWORD` and the matching value inside `DATABASE_URL`, then `docker compose up -d --force-recreate app`. |
| Browser shows a certificate warning | Expected on `OSSHP_DOMAIN=localhost` (Caddy's internal CA). Not expected on a real domain with 80/443 reachable — check Caddy logs (`docker compose logs proxy`) if it persists there. |
| `/setup` redirects to `/login` or shows "already set up" | The bootstrap window closed (an admin already exists). Sign in at `/login`, or use CLI break-glass if you're locked out. |
| Uploaded media / cover images 500 | Garage bucket/key not provisioned yet, or `S3_ACCESS_KEY`/`S3_SECRET_KEY` in `.env` don't match what `garage key create` issued — redo step 4 above. |

---

**Next:** `docs/modules.md` (what Blog/Pages/Photos do), `docs/theme-author-guide.md`
(customizing how the site looks), `docs/backup-restore.md` (protect what you
just set up).
