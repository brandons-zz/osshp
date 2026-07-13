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
- Ports **80** and **443** free on the host — for **direct mode** (the
  default: Caddy needs them for automatic HTTPS; override via
  `HTTP_PORT`/`HTTPS_PORT` in `.env` if they're taken). **Not required in
  Cloudflare Tunnel mode**, which opens no inbound ports at all — see
  "Choosing a deployment mode" just below.
- `openssl` on your local machine (`./scripts/setup.sh` uses it to generate
  every secret below — any recent version works).

osshp runs as four containers: **app** (Next.js/Bun), **db** (Postgres 17),
**storage** (Garage — S3-compatible object storage), **proxy** (Caddy, TLS
termination). All four are defined in `docker-compose.yml`; nothing else needs
to be installed on the host. Cloudflare Tunnel mode adds one more container,
**cloudflared** (the tunnel connector) — see below.

---

## Choosing a deployment mode

osshp exposes your site one of two ways. Pick before you install — it changes
the `setup.sh` invocation and the `docker compose` command you'll use from
then on.

| If your host is… | Use | Why |
| --- | --- | --- |
| A **VPS**, or any machine you can reach from the internet on **ports 80/443** (static IP, or you can port-forward) | **Direct** (default) | Caddy obtains a Let's Encrypt certificate and terminates TLS in-stack. Simplest path; no third party in the request path. |
| A **home network** — dynamic residential IP, **CGNAT**, or no ability to port-forward | **Cloudflare Tunnel** | `cloudflared` dials *out* to Cloudflare, so no inbound ports are opened and your home IP never appears in public DNS. TLS terminates at Cloudflare's edge. |

- **Direct mode** is everything in steps 1–5 below, exactly as written. If
  you don't pass `--mode`, you get direct mode — nothing changes from prior
  releases.
- **Cloudflare Tunnel mode** is direct mode plus a token and one dashboard
  step. Read steps 1–5 for context, then follow
  **"Cloudflare Tunnel mode"** (near the end of this guide) for the parts
  that differ.

**Trade-offs of Cloudflare Tunnel mode**, so you choose with eyes open:

- Cloudflare sits in your request path and terminates TLS at its edge
  (traffic between Cloudflare and your `cloudflared` runs inside the
  encrypted tunnel). You are trusting Cloudflare with edge termination — the
  same trade every Cloudflare-proxied site makes.
- Requires a (free-tier is fine) Cloudflare account and a domain you can add
  to it.
- One more moving part (the `cloudflared` connector) and a dashboard-managed
  ingress rule.
- In return: works from behind CGNAT/dynamic IP with zero port-forwarding,
  and there is no public DNS record pointing at your home IP.

---

## 1. Clone and run first-time setup

```sh
git clone <this-repo> osshp && cd osshp
./scripts/setup.sh
```

That's it — `setup.sh` is the primary install path and does everything up to
"open your browser": it generates `SESSION_SECRET`, `OSSHP_ENCRYPTION_KEY`,
`POSTGRES_PASSWORD` (and substitutes it into `DATABASE_URL`), and Garage's
`rpc_secret`; provisions Garage end-to-end (storage layout, the `osshp-media`
bucket, an app access key, and the grant on it); writes the resulting
`S3_ACCESS_KEY`/`S3_SECRET_KEY` into `.env`; and brings the whole stack up.
The only thing it asks you for is the domain:

```sh
./scripts/setup.sh --domain example.com
```

— or use `localhost` for local evaluation, or omit `--domain` and it'll
prompt you interactively. Set `OSSHP_DOMAIN=example.com` as an environment
variable instead of the flag if you prefer; either way the value becomes
`OSSHP_DOMAIN`, `OSSHP_RP_ID` (domain only), and `OSSHP_ORIGIN`
(`https://<domain>`) in `.env`.

Want to run the published image instead of building from source (see Option B
under "Manual / reference," below, for what this changes)?

```sh
./scripts/setup.sh --domain example.com --pull
```

**Safe to re-run at any time.** `setup.sh` never overwrites or regenerates a
secret that's already set to a real value — rotating `OSSHP_ENCRYPTION_KEY`
would make every existing TOTP secret permanently undecryptable, and rotating
`POSTGRES_PASSWORD` would lock the instance out of its own database, so both
(and every other secret it manages) are strictly fill-empty-fields-only. It
backs up `.env` and `config/garage.toml` before touching either, and skips
Garage provisioning entirely once `S3_ACCESS_KEY`/`S3_SECRET_KEY` are already
set. Re-running on an already-configured instance is a safe no-op / fill-any-
gaps operation — it just re-confirms the stack is up and prints a summary of
what it generated versus what it left alone. `./scripts/setup.sh --help`
covers all the flags.

If `openssl` or `docker` (or the `docker compose` v2 plugin) aren't on your
`PATH`, it fails immediately with a clear message rather than getting partway
through and leaving `.env` half-filled.

The rest of this section (steps 2-4 below) is what `setup.sh` automates,
kept here as **reference** — read it if you want to understand what's
happening under the hood, if you're customizing something it doesn't cover
(a non-default `POSTGRES_USER`/`POSTGRES_DB`, multi-node Garage, etc.), or if
you'd rather do it by hand. If you already ran `./scripts/setup.sh`, skip
ahead to [step 5](#5-open-the-site-and-complete-the-setup-wizard).

## 2. Fill in `.env` (manual / reference)

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
`DATABASE_URL` — they must match exactly. (`setup.sh` does this substitution
for you automatically.)

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
(This shouldn't happen if you used `setup.sh` — every secret it generates is
64 hex chars, well above the floor.)

`OSSHP_ENCRYPTION_KEY` is **optional at boot** (TOTP is opt-in — see
"Recovery lanes" below) but becomes mandatory the moment an operator tries to
enroll TOTP; leaving it unset until then is fine.

## 3. Fill in `config/garage.toml` (manual / reference)

Set `rpc_secret` to a fresh 64-character hex string:

```sh
openssl rand -hex 32
```

Paste the output over `CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32` in
`config/garage.toml`. Everything else in that file is a sane single-node
default (see the comments in the file if you're deploying multi-node — out of
scope for a single self-host).

## 4. Bring the stack up and provision object storage (manual / reference)

You have two options here — pick whichever fits how you want to run osshp.
Both produce the same working instance; only where the `app` image comes
from differs. (`setup.sh --pull` picks Option B for you; plain `setup.sh`
picks Option A.)

**Option A — build from source (default).** `docker compose up` with no
extra flags always builds the `app` image from `./app` on your host. This is
what you get if you just `git clone`d the repo and want to run exactly what's
in your checkout:

```sh
docker compose up -d
```

**Option B — pull the published image.** Instead of building, pull and run
the pre-built `osshp` image from GHCR (`ghcr.io/brandons-zz/osshp`) using the
`docker-compose.ghcr.yml` overlay. This is the faster path if you just want
to run osshp and don't need to build from source yourself:

```sh
docker login ghcr.io                    # once, if the image is private
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull app
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

By default this pulls the current stable release tag
(`ghcr.io/brandons-zz/osshp:0.1.0`). Override with a specific tag or digest
by setting `OSSHP_IMAGE` in `.env` (e.g. `OSSHP_IMAGE=ghcr.io/brandons-zz/osshp:0.2.0`)
before running `up`. Every `docker compose` command in the rest of this guide
that targets the `app` service (e.g. `--force-recreate app` a few steps
below, or an upgrade later) needs the same `-f docker-compose.yml -f
docker-compose.ghcr.yml` flags if you're on Option B — everything else
(Garage provisioning, the setup wizard, recovery lanes) works identically
either way, because both options produce the exact same running image.

Whichever option you chose:

```sh
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

## Cloudflare Tunnel mode

Use this instead of direct mode if your host can't be reached on ports 80/443
(home network, dynamic/CGNAT IP, no port-forwarding). See
"Choosing a deployment mode" at the top for the trade-offs.

**What osshp does vs. what you do.** `setup.sh --mode tunnel` handles the
whole osshp side — it stores your connector token in `.env`, points Caddy at
plain HTTP behind the tunnel, and brings the stack up (including the
`cloudflared` connector) with the tunnel overlay. The **Cloudflare account
side** — creating the tunnel and mapping your public hostname to the osshp
service — is a **manual** step you do once in the Cloudflare dashboard;
osshp deliberately does not automate your Cloudflare account.

**Prerequisites (in addition to the ones at the top of this guide):** a
Cloudflare account (free tier is fine) with a zone for your domain, and
**Docker Compose ≥ 2.24.4** — the tunnel overlay uses the Compose
merge-`!reset` tag to drop the proxy's published ports, which older Compose
versions don't support. `./scripts/setup.sh --mode tunnel` checks this
automatically and fails with guidance if your Compose is older (issue 035);
run `docker compose version` yourself if you want to check ahead of time.

### Step A — create the tunnel and get its token (Cloudflare dashboard)

1. In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/)
   go to **Networks → Tunnels → Create a tunnel**, choose **Cloudflared** as
   the connector type, and give it a name (e.g. your site's name).
2. On the "Install and run a connector" screen, **copy the tunnel token** —
   it's the long string in the shown `cloudflared ... run --token <TOKEN>`
   command. That token is all osshp needs. (You do **not** run that command
   yourself — the osshp `cloudflared` container runs the connector for you.)
   You can retrieve it again later with
   `cloudflared tunnel token <tunnel-name>` or from the tunnel's page.
   **Treat the token as a secret** — it grants the right to serve your
   hostname.
3. Add a **Public Hostname** to the tunnel:
   - **Subdomain / Domain:** the domain (or subdomain) you'll serve osshp at,
     on a zone in your Cloudflare account (e.g. `example.com`).
   - **Service → Type:** `HTTP`
   - **Service → URL:** `proxy:80` — together, `http://proxy:80`. `proxy` is
     the compose **service name**; Docker's embedded DNS resolves it to the
     Caddy container over the dedicated `edge` Docker network that `proxy`
     and `cloudflared` share (see "Network topology" below). It is **not**
     `osshp` (the compose project/stack name — not a hostname), **not**
     `osshp-proxy-1` (the container name), **not** `localhost`, and **not**
     an IP.
   - **Save.** Cloudflare **automatically creates the DNS record** for that
     hostname pointing at the tunnel — this is the whole point: no manual DNS,
     and it works even though your home IP is dynamic and never published.

### Step B — install osshp in tunnel mode

Run setup with the mode and token (everything else is identical to direct
mode — same Garage provisioning, same wizard):

```sh
./scripts/setup.sh --domain example.com --mode tunnel --tunnel-token <TOKEN>
```

- Run it with **no** `--tunnel-token` (and no `CLOUDFLARE_TUNNEL_TOKEN` env
  var) and it prompts you for the token interactively, without echoing it.
- Omit `--mode` entirely and it asks you to choose direct vs tunnel.
- The token is written to `.env` as `CLOUDFLARE_TUNNEL_TOKEN` — the same
  secret-handling class as every other generated secret: `.env` is backed up
  before the write, the value is never printed, and a re-run never overwrites
  it once set.

Under the hood, tunnel mode sets `OSSHP_CADDY_SITE_ADDRESS=http://example.com`
in `.env` so Caddy serves **plain HTTP** on :80 behind the tunnel (no
certificate is requested — TLS is Cloudflare's job at the edge).
`OSSHP_DOMAIN` and `OSSHP_RP_ID` stay **bare** (`example.com`) and
`OSSHP_ORIGIN` stays `https://example.com`, so passkeys and **Secure**
session cookies work normally — browsers still reach your site over HTTPS at
Cloudflare's edge. It also sets `OSSHP_TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip`
— see "Client-IP attribution" below for why tunnel mode needs a header instead
of the X-Forwarded-For hop count direct mode uses.

### The canonical command for a tunnel instance

Tunnel mode runs with an overlay file, so **every** `docker compose` command
for this instance needs both `-f` flags — `setup.sh` already does this for
you, but for anything you run by hand afterwards (logs, restart, upgrade):

```sh
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

The overlay (`docker-compose.tunnel.yml`) does three things: adds the
digest-pinned `cloudflared` connector service, **removes** the proxy's
published 80/443 host ports (nothing needs to reach them from outside — the
tunnel connects over a dedicated Docker network), and puts `cloudflared` and
`proxy` on that dedicated `edge` network instead of the shared `internal`
network `db`/`storage`/`app` are on. Direct mode (`docker compose up -d` with
no overlay) is completely unaffected and remains the default secure posture.

#### Network topology (issue 035 hardening)

The Cloudflare Tunnel connector's ingress rules (which public hostname maps
to which internal service) are dashboard-managed and pulled at runtime using
the connector token — so a compromised token could, in principle, be used to
remap the tunnel to reach anything `cloudflared` can reach on the Docker
network. Since `cloudflared` sits only on `edge` (which has nothing on it but
`proxy`), a stolen token's reach is bounded to the proxy — it cannot resolve
or connect to `db`, `storage`, or `app` directly, even though those services
sit on the same host. `proxy` is on both `internal` (to reverse-proxy to
`app`) and `edge` (to be reachable from `cloudflared`); `db`/`storage`/`app`
never leave `internal`. This has no effect on how the stack behaves — it's a
blast-radius reduction on an already-scoped connector token, not a new
constraint you need to configure.

Running the **published image** as well as the tunnel? Stack all three files:

```sh
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml -f docker-compose.ghcr.yml up -d
```

#### Client-IP attribution

The auth rate-limiter, the audit log, session metadata, and the analytics
module all need to know the real visitor IP. There is one attribution
function (`clientIp()`), and it resolves the IP differently in the two
deployment modes — selected only by operator config, never sniffed from the
request.

**Direct** (and generic-reverse-proxy) mode reads it off `X-Forwarded-For`
via `config.trustedProxyHops` (`OSSHP_TRUSTED_PROXY_HOPS` in `.env`) — the
count of trusted reverse proxies in front of the app that each append one
entry to that header. Direct mode has exactly one such hop (Caddy) and
defaults to `1`; the app picks the entry Caddy appended (the true TCP peer),
and any client-supplied `X-Forwarded-*` is discarded by Caddy, so a forged
header cannot move the key. Unchanged from before.

**Tunnel** mode cannot use `X-Forwarded-For` at all. The request path is
Cloudflare edge → `cloudflared` → Caddy (proxy) → app, and Caddy — with no
`trusted_proxies` configured — treats `cloudflared` as an **untrusted** peer.
So Caddy **discards the entire inbound `X-Forwarded-For`** (the one
Cloudflare's edge populated) and writes a fresh one containing exactly one
entry: `cloudflared`'s internal Docker-network IP. The app therefore receives
a single-entry XFF holding cloudflared's fixed IP — the same value for every
visitor on the internet, and **no hop count can recover the client IP from
it** (this is why the earlier `OSSHP_TRUSTED_PROXY_HOPS=2` model never worked
— it assumed Caddy preserved the inbound chain, which it does not).

The real client IP survives to the app in exactly one header:
**`CF-Connecting-IP`**. Caddy only manipulates the `X-Forwarded-*` family and
passes every other header through untouched, and Cloudflare's edge sets
`CF-Connecting-IP` to the actual connecting address and **overwrites** any
value a client tried to forge — so behind the tunnel it is authoritative and
un-spoofable (a forged header dies at the edge; the only ingress is
cloudflared → Caddy on the isolated `edge` network with the proxy's host
ports dropped).

Tunnel mode therefore sets **`OSSHP_TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip`**.
When this var is set, `clientIp()` reads the client IP from **only** that
header, validates it is IP-shaped, and applies **no X-Forwarded-For
fallback** — a missing or malformed header yields an unattributable request
(rate-limit key `unknown`, with the IP-independent global per-lane cap still
binding). Fail-closed on purpose: falling back to XFF would let exactly the
request that did *not* transit Cloudflare pick its own attribution through the
weaker path.

`./scripts/setup.sh --mode tunnel` sets `OSSHP_TRUSTED_CLIENT_IP_HEADER` for
you automatically — same fill-empty-fields-only handling as every other value
it writes; it never overrides a value you've already set. It no longer writes
`OSSHP_TRUSTED_PROXY_HOPS` for new tunnel installs (an existing value is left
in place and is harmless — the header var preempts it).

> **SECURITY — generic reverse proxies:** `OSSHP_TRUSTED_CLIENT_IP_HEADER` is
> safe **only** when every network route to the app overwrites that header at
> trusted infrastructure (as Cloudflare's edge does in tunnel mode). If your
> own proxy sits in front of osshp, set this to a header your proxy *guarantees*
> to set (e.g. nginx `proxy_set_header X-Real-IP $remote_addr`) **and** ensure
> the app is not directly reachable. If the app can be hit directly, a client
> can forge the header and choose its own attributed IP — leave the var unset
> and use `OSSHP_TRUSTED_PROXY_HOPS` instead.

**Switching a tunnel instance back to direct mode:** drop the
`-f docker-compose.tunnel.yml` overlay from your commands **and** remove
`OSSHP_CADDY_SITE_ADDRESS` **and** `OSSHP_TRUSTED_CLIENT_IP_HEADER` from
`.env`. The `OSSHP_CADDY_SITE_ADDRESS` step matters — a stale `http://<domain>`
value left in `.env` with a base-only `docker compose up -d` would make
Caddy serve **plain HTTP on the now-published ports 80/443** instead of
terminating TLS. With the line removed, Caddy falls back to the bare
`OSSHP_DOMAIN` and does automatic HTTPS again. The
`OSSHP_TRUSTED_CLIENT_IP_HEADER` step matters too — leaving it set while the
app is served directly by Caddy means the app trusts a `CF-Connecting-IP`
header that is now client-forgeable (no Cloudflare edge in front to overwrite
it). Removing it restores the correct direct-mode XFF/hops attribution.

### Verify

```sh
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml logs cloudflared
#   → look for "Registered tunnel connection" / connections established
cloudflared tunnel list      # (if you have the cloudflared CLI) shows connections > 0
```

Then browse to `https://example.com` — it serves through Cloudflare's edge
with a valid certificate (no browser warning), and admin passkey enrollment +
login work at that domain.

---

## Changing the domain of a live instance (passkey caveat)

**Read this before you move an already-running instance to a new domain**
(for example `localhost` → `example.com`, or between two real domains — a
common step when you first put a home instance behind a tunnel).

WebAuthn binds every enrolled passkey to the **RP ID** (`OSSHP_RP_ID`, the
bare domain). **Changing the domain changes the RP ID, which orphans every
passkey already enrolled under the old domain** — they will no longer
authenticate. This is a WebAuthn guarantee, not an osshp limitation.

Because of that, `setup.sh` treats the domain as write-once: once
`OSSHP_DOMAIN` is set to a real value it is **never** silently rewritten, even
if you re-run with a different `--domain`. If it detects that you passed a
different domain than the one already configured, it **warns** and leaves the
existing values untouched rather than quietly orphaning your credentials.

To deliberately move a live instance to a new domain:

1. Make sure you have a working **recovery lane** set up (password + TOTP, or
   unused recovery codes — see "Recovery lanes" above), **or** be ready to use
   the **CLI break-glass** path on the host. You will re-enroll your passkey
   after the move, and the old one will not work.
2. Edit `.env` by hand and set all three to the new domain:
   `OSSHP_DOMAIN=newdomain.com`, `OSSHP_RP_ID=newdomain.com`,
   `OSSHP_ORIGIN=https://newdomain.com`. (In tunnel mode also update
   `OSSHP_CADDY_SITE_ADDRESS=http://newdomain.com`, and update the tunnel's
   public hostname in the Cloudflare dashboard to the new domain.)
3. Recreate the affected services so they pick up the new values (an `.env`
   change needs a recreate, not just a restart):

   ```sh
   # direct mode
   docker compose up -d --force-recreate app proxy
   # tunnel mode
   docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --force-recreate app proxy cloudflared
   ```

4. Go to `https://newdomain.com/login`, use a **recovery lane** (or
   break-glass) to get in, and **re-enroll a passkey** under the new domain
   from **Admin → Account → Security**. Regenerate recovery codes while
   you're there.

---

## Completely removing / reinstalling osshp

**Read this before you delete an osshp project directory** — the order you
tear things down in matters, and getting it backwards produces a confusing
failure the next time you install.

### Why this matters: named volumes outlive the directory

`docker-compose.yml` stores Postgres data, object storage data, and Caddy's
TLS state in **named volumes** (`db-data`, `garage-data`, `garage-meta`,
`caddy-data`, `caddy-config`), not in bind-mounted folders under the project
directory. Named volumes are **owned and stored by the Docker daemon**, not
by your project checkout — on macOS and Windows they live *inside the Docker
Desktop VM*, invisible to `ls`, Finder, or any host-filesystem browse. Deleting
the project directory (`rm -rf osshp/`, or just `git clone`-ing over the same
path again) does **not** delete these volumes. They persist, orphaned, until
something explicitly removes them.

This is exactly the trap in the "stale volume" failure mode: reuse a project
directory (or its default `COMPOSE_PROJECT_NAME`) after a prior instance's
volumes were never cleaned up, and `./scripts/setup.sh` writes a **fresh**
`POSTGRES_PASSWORD` into the new `.env` while Postgres itself boots from the
**old** volume — which only ever applies a password at first init of an empty
data directory, so it keeps the old one. The result is a cryptic
`password authentication failed for user "osshp"` (`28P01`) with no obvious
cause, because nothing about the fresh `.env` looks wrong. `setup.sh` now
detects this specific case (an existing `<project>_db-data` volume paired
with a not-yet-set `POSTGRES_PASSWORD`) and prints a warning naming the
volume before it happens — but the guard is advisory only; it never deletes
anything, so it's still on you to tear down correctly.

### The correct order

**Tear down with `-v` *before* you delete the directory — never after:**

```sh
cd osshp   # the stack's own directory — docker compose reads compose files relative to cwd
docker compose down -v --remove-orphans
# now it's safe to delete the directory
cd ..
rm -rf osshp
```

`-v` removes the named volumes declared in the compose file (all of the data
above); `--remove-orphans` cleans up containers from services no longer in
the compose file (e.g. after switching deployment modes). Once you run
`docker compose down -v` you cannot recover the data in those volumes — this
is destructive by design, the same as it would be for any database.

If you deleted the directory **first** and only now realize the volumes are
still out there, `docker compose down -v` won't help — there's no compose
file left to read. Find and remove them directly instead:

```sh
# List every volume belonging to an osshp-labeled project (Compose tags every
# volume it creates with a com.docker.compose.project label — this is the
# only reliable way to find them once the directory that created them is gone):
docker volume ls --filter label=com.docker.compose.project=osshp

# (If you customized COMPOSE_PROJECT_NAME, filter on that name instead of
# "osshp" — see the comment at the top of docker-compose.yml.)

# Remove them once you've confirmed they're the ones you mean to delete:
docker volume rm osshp_db-data osshp_garage-data osshp_garage-meta osshp_caddy-data osshp_caddy-config
```

`docker volume ls` (no filter) also works, but lists every volume on the
host from every project — the label filter is what makes this reliable
without you having to eyeball names.

### Reinstalling after a clean teardown

Once `docker compose down -v` has run (or the orphaned volumes above are
removed), a fresh `git clone` + `./scripts/setup.sh` in the same or a new
directory starts completely clean — no stale password, no leftover object
storage state.

---

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
| `app` fails with `password authentication failed for user "osshp"` (`28P01`) right after a fresh `./scripts/setup.sh` run | A **stale `db-data` volume** from a prior instance — Postgres only applies `POSTGRES_PASSWORD` at first init of an empty data directory, so a reused volume keeps its old password. `setup.sh` warns about this (naming the volume) when it detects one already exists at the moment it's about to generate a new password. See "Completely removing / reinstalling osshp" above for the fix (`docker compose down -v`, or `docker volume rm <name>`). |
| `app` container unhealthy on first boot, logs show `ERR_INVALID_URL` or a malformed `DATABASE_URL` | `POSTGRES_PASSWORD` (or the copy of it inside `DATABASE_URL`) contains a URL special character like `/` or `+` — usually left over from a `base64`-generated password. Regenerate with `openssl rand -hex 24`, update **both** `POSTGRES_PASSWORD` and the matching value inside `DATABASE_URL`, then `docker compose up -d --force-recreate app`. |
| Browser shows a certificate warning | Expected on `OSSHP_DOMAIN=localhost` (Caddy's internal CA). Not expected on a real domain with 80/443 reachable — check Caddy logs (`docker compose logs proxy`) if it persists there. |
| `/setup` redirects to `/login` or shows "already set up" | The bootstrap window closed (an admin already exists). Sign in at `/login`, or use CLI break-glass if you're locked out. |
| Uploaded media / cover images 500 | Garage bucket/key not provisioned yet, or `S3_ACCESS_KEY`/`S3_SECRET_KEY` in `.env` don't match what `garage key create` issued — redo step 4 above. |
| `./scripts/setup.sh` says "openssl is required" / "docker is required" | The tool isn't on `PATH`. Install it and re-run — the script does nothing else until both preflight checks pass. |
| `./scripts/setup.sh` says "OSSHP_DOMAIN is not set and no domain was supplied" | Running non-interactively (a script, CI, no TTY) with neither `--domain` nor an `OSSHP_DOMAIN` env var set. Pass one of those. |
| A Garage key named `osshp-app-key` already exists but `.env` still shows placeholder S3 keys | `setup.sh` warns and creates a differently-named key rather than guessing at a secret it can't retrieve (Garage only shows a key's secret once, at creation). Safe to leave the old key in place, or delete it by hand once you've confirmed it's unused. |
| Want to confirm `setup.sh` didn't change something it shouldn't have | Check the printed "Generated (new)" vs "Preserved" summary at the end of the run, and look for `.env.bak-*` / `config/garage.toml.bak-*` files if you want to diff against the pre-run state. |
| **Tunnel mode:** site unreachable, `cloudflared` logs show no connections | The connector never registered. Check the token is correct (`docker compose ... logs cloudflared` for an auth error), and that you ran with the tunnel overlay (`-f docker-compose.yml -f docker-compose.tunnel.yml`) so the `cloudflared` service actually started. |
| **Tunnel mode:** Cloudflare shows **502 / Bad Gateway** | The tunnel's public-hostname **Service URL** is wrong. It must be `http://proxy:80` — `proxy` is the compose **service name**, resolved over the `edge` Docker network `proxy` and `cloudflared` share. Not `osshp` (the compose project/stack name), not `osshp-proxy-1` (the container name), not `localhost`, not an IP, not `https`. Fix it in the dashboard and save. |
| **Tunnel mode:** `setup.sh --mode tunnel` fails immediately with a Docker Compose version error | Your `docker compose` is older than 2.24.4 — it doesn't support the merge-`!reset` tag the tunnel overlay needs (see "Prerequisites" above). Upgrade the Compose v2 plugin and re-run; direct mode is unaffected and needs no such upgrade. |
| **Tunnel mode:** passkey stops working after going live | You changed the domain (e.g. `localhost` → your real domain), which changes the RP ID and orphans passkeys enrolled under the old one. Expected — re-enroll via a recovery lane; see "Changing the domain of a live instance" above. |

---

**Next:** `docs/modules.md` (what Blog/Pages/Photos do), `docs/theme-author-guide.md`
(customizing how the site looks), `docs/backup-restore.md` (protect what you
just set up).
