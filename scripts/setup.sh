#!/usr/bin/env bash
# setup.sh — Auto-provisioning first-run setup for the osshp stack.
#
# Generates every machine-generatable secret (SESSION_SECRET,
# OSSHP_ENCRYPTION_KEY, POSTGRES_PASSWORD + the matching DATABASE_URL,
# Garage's rpc_secret), provisions Garage object storage end-to-end
# (cluster layout, bucket, access key, grant), and wires the resulting S3
# credentials into .env — then brings the whole stack up. The only thing
# this script needs from you is the domain.
#
# GUARDRAILS (read before you re-run this on a live instance):
#   - NEVER overwrites or regenerates a secret that already holds a real
#     (non-empty, non-placeholder) value. Rotating OSSHP_ENCRYPTION_KEY
#     would make every existing TOTP secret permanently undecryptable;
#     rotating POSTGRES_PASSWORD would lock this instance out of its own
#     database. Every generator below is fill-empty-fields-only.
#   - .env and config/garage.toml are each backed up (once per run, before
#     the first edit to that file) to <file>.bak-<UTC-timestamp>.
#   - Garage provisioning is skipped entirely once S3_ACCESS_KEY and
#     S3_SECRET_KEY are already set in .env.
#   - Re-running this on an already-configured instance is a safe no-op /
#     fill-gaps-only operation: it will not rotate any secret and will not
#     re-provision Garage. It still brings the stack up (harmless, and
#     matches the "one command" goal for both first run and every run
#     after).
#   - A generated-vs-preserved summary is printed at the end of every run.
#
# Usage:
#   ./scripts/setup.sh                            # prompts for domain (+ mode)
#   ./scripts/setup.sh --domain example.com        # non-interactive, direct mode
#   OSSHP_DOMAIN=example.com ./scripts/setup.sh    # same, via env var
#   ./scripts/setup.sh --domain example.com --pull
#     # brings the stack up via the published GHCR image
#     # (docker-compose.ghcr.yml overlay) instead of building from source —
#     # see "Option B" in docs/setup-runbook.md.
#   ./scripts/setup.sh --domain example.com --mode tunnel --tunnel-token <token>
#     # Cloudflare Tunnel mode: cloudflared dials out to Cloudflare (no open
#     # ports, home IP never in DNS), Caddy serves plain HTTP behind the
#     # tunnel, TLS terminates at Cloudflare's edge. For home / dynamic-IP /
#     # CGNAT hosting — see "Cloudflare Tunnel mode" in docs/setup-runbook.md.
#     # The Cloudflare account side (create tunnel + public-hostname→service
#     # mapping) is a documented MANUAL step; this script does not automate it.
#
# Deployment mode is DIRECT (Caddy public TLS) by default — existing behavior,
# unchanged. Only --mode tunnel (or OSSHP_DEPLOY_MODE=tunnel) opts into the
# Cloudflare Tunnel path.
#
# Run from anywhere inside the repo — it cd's to the osshp/ directory
# itself before doing anything.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

ENV_FILE=".env"
ENV_EXAMPLE=".env.example"
GARAGE_TOML="config/garage.toml"
GARAGE_EXAMPLE="config/garage.toml.example"

# ---- helpers ------------------------------------------------------------

info()  { echo "[setup] $*"; }
warn()  { echo "[setup] WARNING: $*" >&2; }
die()   { echo "[setup] ERROR: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./scripts/setup.sh [--domain <domain>] [--mode direct|tunnel]
                          [--tunnel-token <token>] [--pull] [-h|--help]

  --domain <domain>    Domain (or "localhost") this instance is served at.
                        Skips the interactive prompt. Same effect as setting
                        the OSSHP_DOMAIN environment variable.
  --mode <mode>        Deployment mode: "direct" (default — Caddy terminates
                        public TLS on 80/443; VPS / port-forwardable hosts) or
                        "tunnel" (Cloudflare Tunnel; home / dynamic-IP / CGNAT
                        hosts — no open ports). Same effect as OSSHP_DEPLOY_MODE.
  --tunnel-token <t>   Cloudflare Tunnel connector token (required for
                        --mode tunnel). A SECRET — stored in .env, never logged.
                        Same effect as the CLOUDFLARE_TUNNEL_TOKEN env var.
                        Retrieve with `cloudflared tunnel token <name>` or from
                        the Zero Trust dashboard.
  --pull               Bring the stack up via the published GHCR image
                        (docker-compose.ghcr.yml overlay) instead of
                        building the app image from source.
  -h, --help           Show this help.

The Cloudflare account side (creating the tunnel and mapping the public
hostname to Service Type=HTTP, URL=proxy:80 — i.e. http://proxy:80, the
compose SERVICE name, NOT osshp / osshp-proxy-1 / localhost / an IP) is a
documented MANUAL step — this script handles only the osshp side. See
docs/setup-runbook.md.

Safe to re-run at any time: never overwrites an already-set secret (including
the tunnel token), never re-provisions an already-provisioned Garage instance.
See docs/setup-runbook.md for the full walkthrough and the manual/reference
steps this script replaces.
EOF
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 \
    || die "'$1' is required but not found on PATH. Install it and re-run."
}

# Dotted-decimal version compare: returns 0 (true) if $1 >= $2. Strips a
# leading 'v' and anything from the first non "digits/dots" character
# onward (build metadata / pre-release suffixes), so both "v2.24.4" and
# "2.24.4-desktop.1" compare correctly on their numeric prefix.
version_ge() {
  local v1 v2
  v1="$(printf '%s' "$1" | sed -E 's/^v//; s/[^0-9.].*$//')"
  v2="$(printf '%s' "$2" | sed -E 's/^v//; s/[^0-9.].*$//')"
  [ "${v1}" = "${v2}" ] && return 0
  local -a a b
  read -ra a <<< "${v1//./ }"
  read -ra b <<< "${v2//./ }"
  local i n ai bi
  n=${#a[@]}
  [ "${#b[@]}" -gt "${n}" ] && n=${#b[@]}
  for ((i = 0; i < n; i++)); do
    ai="${a[i]:-0}"; bi="${b[i]:-0}"
    ((10#${ai} > 10#${bi})) && return 0
    ((10#${ai} < 10#${bi})) && return 1
  done
  return 0
}

# A value counts as "already configured" only if it is non-empty and not
# one of the shipped placeholder literals. Anything else (including a
# value the operator typed themselves) is preserved, never touched.
is_placeholder() {
  local v="$1"
  [ -z "${v}" ] && return 0
  case "${v}" in
    CHANGE_ME|CHANGE_ME_*) return 0 ;;
  esac
  return 1
}

# Portable `sed -i` — GNU sed takes `-i SCRIPT`, BSD/macOS sed requires
# `-i ''`. `sed --version` succeeds only on GNU sed.
sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

# Safe KEY=VALUE .env reader — no `source`/`eval`, so a value can never be
# interpreted as shell (same defensive pattern as restore.sh's loader).
# Strips one layer of surrounding quotes, if present.
osshp_get_env() {
  local file="$1" want="$2" line key value
  [ -f "${file}" ] || return 0
  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in
      "${want}"=*)
        value="${line#*=}"
        case "${value}" in
          \"*\") value="${value#\"}"; value="${value%\"}" ;;
          \'*\') value="${value#\'}"; value="${value%\'}" ;;
        esac
        printf '%s' "${value}"
        return 0
        ;;
    esac
  done < "${file}"
}

# Replace an existing KEY=... line in-place, or append if the key is
# absent. Delimiter is `|` (not `/`) so URL-shaped values like
# DATABASE_URL don't need escaping; `&` and the delimiter itself are
# escaped in the replacement text as defense in depth.
osshp_set_env() {
  local file="$1" key="$2" value="$3" escaped
  escaped="$(printf '%s' "${value}" | sed -e 's/[\&|]/\\&/g')"
  if grep -qE "^${key}=" "${file}"; then
    sed_inplace "s|^${key}=.*|${key}=${escaped}|" "${file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

# Backed up at most once per run, and only if the file already exists
# (nothing to back up on a from-scratch first run).
ENV_BACKED_UP=false
GARAGE_BACKED_UP=false
backup_once() {
  local f="$1" ts
  if [ "${f}" = "${ENV_FILE}" ]; then
    [ "${ENV_BACKED_UP}" = true ] && return 0
  elif [ "${f}" = "${GARAGE_TOML}" ]; then
    [ "${GARAGE_BACKED_UP}" = true ] && return 0
  else
    die "backup_once: unrecognized file '${f}'"
  fi
  if [ -f "${f}" ]; then
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    cp "${f}" "${f}.bak-${ts}"
    info "Backed up ${f} -> ${f}.bak-${ts}"
  fi
  if [ "${f}" = "${ENV_FILE}" ]; then
    ENV_BACKED_UP=true
  else
    GARAGE_BACKED_UP=true
  fi
}

# ---- arg parsing ----------------------------------------------------------

PULL_MODE=false
DOMAIN_ARG="${OSSHP_DOMAIN:-}"
# Deployment mode: direct (default) | tunnel. Env-var equivalent for
# non-interactive runs, mirroring the --domain / OSSHP_DOMAIN pattern.
DEPLOY_MODE="${OSSHP_DEPLOY_MODE:-}"
# Cloudflare Tunnel connector token (secret). Flag or CLOUDFLARE_TUNNEL_TOKEN env.
TUNNEL_TOKEN_ARG="${CLOUDFLARE_TUNNEL_TOKEN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)
      [ $# -ge 2 ] || die "--domain requires a value"
      DOMAIN_ARG="$2"; shift 2 ;;
    --domain=*)
      DOMAIN_ARG="${1#*=}"; shift ;;
    --mode)
      [ $# -ge 2 ] || die "--mode requires a value (direct or tunnel)"
      DEPLOY_MODE="$2"; shift 2 ;;
    --mode=*)
      DEPLOY_MODE="${1#*=}"; shift ;;
    --tunnel-token)
      [ $# -ge 2 ] || die "--tunnel-token requires a value"
      TUNNEL_TOKEN_ARG="$2"; shift 2 ;;
    --tunnel-token=*)
      TUNNEL_TOKEN_ARG="${1#*=}"; shift ;;
    --pull)
      PULL_MODE=true; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      die "Unknown option: $1 (see --help)" ;;
  esac
done

# Resolve deployment mode. Interactive runs may prompt (below, once .env
# exists); non-interactive runs default to "direct" so existing invocations
# — `--domain example.com` with no --mode — behave exactly as before.
if [ -n "${DEPLOY_MODE}" ]; then
  case "${DEPLOY_MODE}" in
    direct|tunnel) ;;
    *) die "Invalid --mode '${DEPLOY_MODE}' (expected 'direct' or 'tunnel')." ;;
  esac
elif [ ! -t 0 ]; then
  DEPLOY_MODE="direct"
fi
# If still empty here we have a TTY and will prompt after .env is ready.

# ---- preflight: fail loud on missing tools --------------------------------

require_tool openssl
require_tool docker
docker compose version >/dev/null 2>&1 \
  || die "'docker compose' (the v2 plugin) is required — the standalone docker-compose v1 binary is not supported."

# ---- deployment mode: interactive prompt if a TTY and none was supplied ----

if [ -z "${DEPLOY_MODE}" ]; then
  echo "Deployment mode:"
  echo "  1) Direct — Caddy terminates public TLS on 80/443 (default)."
  echo "       VPS or any host you can reach on ports 80/443."
  echo "  2) Cloudflare Tunnel — cloudflared dials out; no open ports, home"
  echo "       IP stays out of DNS. Home / dynamic IP / CGNAT hosting."
  read -r -p "Choose 1 or 2 [1]: " _mode_choice
  case "${_mode_choice}" in
    2|tunnel) DEPLOY_MODE="tunnel" ;;
    ""|1|direct) DEPLOY_MODE="direct" ;;
    *) die "Invalid choice '${_mode_choice}' (expected 1 or 2)." ;;
  esac
fi

# ---- tunnel mode: hard Docker Compose version floor ------------------------
# docker-compose.tunnel.yml's `proxy.ports: !reset []` depends on the Compose
# Spec `!reset` merge tag, supported starting Docker Compose v2.24.4. On an
# older `docker compose` that doesn't understand the tag, the merge either
# errors or (on some older releases) silently keeps the base file's port
# list — publishing 80/443 on the host even though tunnel mode was chosen
# specifically to avoid that. Fail loud before touching anything (issue 035).
COMPOSE_VERSION_FLOOR="2.24.4"
if [ "${DEPLOY_MODE}" = tunnel ]; then
  compose_version="$(docker compose version --short 2>/dev/null || true)"
  if [ -z "${compose_version}" ]; then
    compose_version="$(docker compose version 2>/dev/null \
      | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    compose_version="${compose_version#v}"
  fi
  [ -n "${compose_version}" ] \
    || die "Could not determine the Docker Compose version ('docker compose version --short' produced no output). Tunnel mode requires Docker Compose >= ${COMPOSE_VERSION_FLOOR} — upgrade the Compose v2 plugin and re-run."
  version_ge "${compose_version}" "${COMPOSE_VERSION_FLOOR}" \
    || die "Tunnel mode requires Docker Compose >= ${COMPOSE_VERSION_FLOOR} (found ${compose_version}). Older versions don't support the Compose merge-'!reset' tag that docker-compose.tunnel.yml uses to drop the proxy's published host ports — on an older Compose those ports can stay published even in tunnel mode, exposing the app stack on 80/443 to anything that can reach this host. Upgrade Docker Compose (the v2 plugin, e.g. via Docker Desktop or docker-compose-plugin) to ${COMPOSE_VERSION_FLOOR} or newer and re-run. (Direct mode has no such requirement and is unaffected.)"
fi

# ---- compose command: build-from-source (default) vs pull-based overlay,  --
# ---- plus the Cloudflare Tunnel overlay when --mode tunnel is selected.   --

COMPOSE_FILES=(-f docker-compose.yml)
if [ "${PULL_MODE}" = true ]; then
  [ -f docker-compose.ghcr.yml ] \
    || die "--pull requested but docker-compose.ghcr.yml is missing from ${REPO_ROOT}."
  COMPOSE_FILES+=(-f docker-compose.ghcr.yml)
fi
if [ "${DEPLOY_MODE}" = tunnel ]; then
  [ -f docker-compose.tunnel.yml ] \
    || die "tunnel mode requested but docker-compose.tunnel.yml is missing from ${REPO_ROOT}."
  COMPOSE_FILES+=(-f docker-compose.tunnel.yml)
fi
COMPOSE=(docker compose "${COMPOSE_FILES[@]}" --project-directory "${REPO_ROOT}")

# ---- summary tracking -------------------------------------------------------

GENERATED=()
PRESERVED=()

# ============================================================================
# config/garage.toml
# ============================================================================

if [ -d "${GARAGE_TOML}" ]; then
  warn "${GARAGE_TOML} is a directory (Docker auto-created it). Removing stale dir."
  rmdir "${GARAGE_TOML}"
fi

if [ ! -f "${GARAGE_TOML}" ]; then
  cp "${GARAGE_EXAMPLE}" "${GARAGE_TOML}"
  info "Created ${GARAGE_TOML} from example."
fi

current_rpc="$(sed -nE 's/^rpc_secret = "(.*)"/\1/p' "${GARAGE_TOML}")"
if is_placeholder "${current_rpc}"; then
  backup_once "${GARAGE_TOML}"
  new_rpc="$(openssl rand -hex 32)"
  sed_inplace "s|^rpc_secret = .*|rpc_secret = \"${new_rpc}\"|" "${GARAGE_TOML}"
  GENERATED+=("garage rpc_secret (config/garage.toml)")
else
  PRESERVED+=("garage rpc_secret (config/garage.toml) — already set")
fi

# ============================================================================
# .env
# ============================================================================

if [ ! -f "${ENV_FILE}" ]; then
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
  info "Created ${ENV_FILE} from example."
fi

# ---- domain / RP ID / origin — the one value that needs operator input ---

current_domain="$(osshp_get_env "${ENV_FILE}" OSSHP_DOMAIN)"
domain=""
if is_placeholder "${current_domain}"; then
  domain="${DOMAIN_ARG}"
  if [ -z "${domain}" ]; then
    if [ -t 0 ]; then
      read -r -p "Domain this instance will be served at (e.g. example.com, or 'localhost' for local eval): " domain
    else
      die "OSSHP_DOMAIN is not set and no domain was supplied. Pass --domain <domain> (or set OSSHP_DOMAIN) when running non-interactively."
    fi
  fi
  # Accept a bare domain, or forgive a pasted URL: strip scheme, path, port.
  domain="${domain#http://}"
  domain="${domain#https://}"
  domain="${domain%%/*}"
  domain="${domain%%:*}"
  [ -n "${domain}" ] || die "Domain must not be empty."

  backup_once "${ENV_FILE}"
  osshp_set_env "${ENV_FILE}" OSSHP_DOMAIN "${domain}"
  osshp_set_env "${ENV_FILE}" OSSHP_RP_ID "${domain}"
  osshp_set_env "${ENV_FILE}" OSSHP_ORIGIN "https://${domain}"
  GENERATED+=("OSSHP_DOMAIN / OSSHP_RP_ID / OSSHP_ORIGIN (domain: ${domain})")
else
  domain="${current_domain}"
  PRESERVED+=("OSSHP_DOMAIN / OSSHP_RP_ID / OSSHP_ORIGIN — already set (domain: ${current_domain})")
  # Requirement 6: warn on an attempted RP-ID (domain) change. We PRESERVE the
  # existing value (never silently rotate it), but if the operator passed a
  # different --domain / OSSHP_DOMAIN they likely intend to move the instance —
  # and changing the RP ID orphans every enrolled passkey (WebAuthn binds
  # credentials to the RP ID). Surface it loudly and point at the re-enroll path.
  incoming_domain="${DOMAIN_ARG}"
  incoming_domain="${incoming_domain#http://}"
  incoming_domain="${incoming_domain#https://}"
  incoming_domain="${incoming_domain%%/*}"
  incoming_domain="${incoming_domain%%:*}"
  if [ -n "${incoming_domain}" ] && [ "${incoming_domain}" != "${current_domain}" ]; then
    warn "You passed domain '${incoming_domain}', but this .env is already configured for '${current_domain}'. Its OSSHP_DOMAIN / OSSHP_RP_ID / OSSHP_ORIGIN were LEFT UNCHANGED (this script never rotates an already-set value). Changing a live instance's domain changes the WebAuthn RP ID, which ORPHANS every enrolled passkey — you would have to re-enroll via the recovery flow (docs/setup-runbook.md 'Changing the domain of a live instance'). To actually move domains, follow that section deliberately rather than re-running setup.sh."
  fi
fi

# ---- Cloudflare Tunnel configuration (tunnel mode only) ---------------------
# Direct mode writes NOTHING here, so its .env is byte-for-byte identical to
# before this feature: no OSSHP_CADDY_SITE_ADDRESS, no CLOUDFLARE_TUNNEL_TOKEN,
# no OSSHP_TRUSTED_PROXY_HOPS. In tunnel mode we set:
#   - OSSHP_CADDY_SITE_ADDRESS=http://<domain>  → Caddy serves plain HTTP
#     behind the tunnel (TLS at Cloudflare's edge). OSSHP_DOMAIN / OSSHP_RP_ID
#     stay bare, OSSHP_ORIGIN stays https://<domain> — Secure cookies + WebAuthn
#     are unaffected.
#   - CLOUDFLARE_TUNNEL_TOKEN=<token>  → the connector's secret. Same handling
#     class as the other generated secrets: backed up before write, never
#     overwritten once set, never echoed.
#   - OSSHP_TRUSTED_PROXY_HOPS=2  → the tunnel chain is Cloudflare edge →
#     cloudflared → Caddy (proxy) → app, TWO hops that touch
#     X-Forwarded-For (Cloudflare's edge sets the real client IP as the
#     first entry; Caddy's reverse_proxy then appends the peer IT observed,
#     which in this topology is cloudflared's internal container IP, not
#     the client — cloudflared itself passes the header through unmodified).
#     `config.trustedProxyHops` defaults to 1 (correct for direct mode's
#     single Caddy hop). Left at the default 1 in tunnel mode,
#     `forwardedClientIp()` picks the LAST XFF entry — cloudflared's fixed
#     internal IP for every request from every visitor on the internet —
#     collapsing the auth rate-limiter's per-client key and the analytics
#     unique-visitor hash to one shared bucket/value (issue 070). See
#     docs/setup-runbook.md → "Trusted proxy hops" for the full chain
#     reasoning. Fill-empty-fields-only like every other value here.

if [ "${DEPLOY_MODE}" = tunnel ]; then
  # Site address for Caddy — fill only if unset/placeholder (preserve on re-run).
  current_site="$(osshp_get_env "${ENV_FILE}" OSSHP_CADDY_SITE_ADDRESS)"
  if is_placeholder "${current_site}"; then
    backup_once "${ENV_FILE}"
    osshp_set_env "${ENV_FILE}" OSSHP_CADDY_SITE_ADDRESS "http://${domain}"
    GENERATED+=("OSSHP_CADDY_SITE_ADDRESS (http://${domain} — tunnel mode, Caddy serves plain HTTP behind the edge)")
  else
    PRESERVED+=("OSSHP_CADDY_SITE_ADDRESS — already set (${current_site})")
  fi

  # Trusted proxy hop count for the auth rate-limiter / analytics client-IP
  # resolution (issue 070) — fill only if unset/placeholder (preserve on
  # re-run / an operator override).
  current_hops="$(osshp_get_env "${ENV_FILE}" OSSHP_TRUSTED_PROXY_HOPS)"
  if is_placeholder "${current_hops}"; then
    backup_once "${ENV_FILE}"
    osshp_set_env "${ENV_FILE}" OSSHP_TRUSTED_PROXY_HOPS "2"
    GENERATED+=("OSSHP_TRUSTED_PROXY_HOPS (2 — tunnel mode: Cloudflare edge + Caddy both touch X-Forwarded-For)")
  else
    PRESERVED+=("OSSHP_TRUSTED_PROXY_HOPS — already set (${current_hops})")
  fi

  # Connector token (SECRET).
  current_token="$(osshp_get_env "${ENV_FILE}" CLOUDFLARE_TUNNEL_TOKEN)"
  if is_placeholder "${current_token}"; then
    token="${TUNNEL_TOKEN_ARG}"
    if [ -z "${token}" ]; then
      if [ -t 0 ]; then
        # -s: do not echo the secret to the terminal.
        read -r -s -p "Cloudflare Tunnel connector token (from 'cloudflared tunnel token <name>' or the Zero Trust dashboard): " token
        echo ""
      else
        die "Tunnel mode selected but no connector token was supplied. Pass --tunnel-token <token> (or set CLOUDFLARE_TUNNEL_TOKEN) when running non-interactively."
      fi
    fi
    [ -n "${token}" ] || die "Cloudflare Tunnel token must not be empty."
    backup_once "${ENV_FILE}"
    osshp_set_env "${ENV_FILE}" CLOUDFLARE_TUNNEL_TOKEN "${token}"
    GENERATED+=("CLOUDFLARE_TUNNEL_TOKEN (tunnel connector token — value not shown)")
  else
    PRESERVED+=("CLOUDFLARE_TUNNEL_TOKEN — already set (value not shown)")
  fi
fi

# ---- SESSION_SECRET ---------------------------------------------------------

current="$(osshp_get_env "${ENV_FILE}" SESSION_SECRET)"
if is_placeholder "${current}"; then
  backup_once "${ENV_FILE}"
  osshp_set_env "${ENV_FILE}" SESSION_SECRET "$(openssl rand -hex 32)"
  GENERATED+=("SESSION_SECRET")
else
  PRESERVED+=("SESSION_SECRET — already set")
fi

# ---- OSSHP_ENCRYPTION_KEY ----------------------------------------------------

current="$(osshp_get_env "${ENV_FILE}" OSSHP_ENCRYPTION_KEY)"
if is_placeholder "${current}"; then
  backup_once "${ENV_FILE}"
  osshp_set_env "${ENV_FILE}" OSSHP_ENCRYPTION_KEY "$(openssl rand -hex 32)"
  GENERATED+=("OSSHP_ENCRYPTION_KEY")
else
  PRESERVED+=("OSSHP_ENCRYPTION_KEY — already set")
fi

# ---- POSTGRES_PASSWORD (+ matching substitution into DATABASE_URL) ---------
#
# Stale-volume guard: Postgres only applies POSTGRES_PASSWORD on first init
# of an EMPTY data directory. If a docker-compose-managed `db-data` volume
# for this project already exists (reused from a prior instance, or the
# project directory was deleted and recreated without `docker compose down
# -v` first), Postgres boots with whatever password is already baked into
# that volume — not the fresh one we're about to generate — and the app
# fails closed with a cryptic "password authentication failed for user ...
# (28P01)". This check is advisory only: it never deletes, renames, or
# otherwise touches the volume — it only warns loud enough for the operator
# to decide before it bites. See docs/setup-runbook.md "Completely removing
# / reinstalling osshp".
osshp_warn_if_stale_db_volume() {
  local project vol
  project="${COMPOSE_PROJECT_NAME:-osshp}"
  # Mirror Compose's own project-name normalization (lowercase) so the check
  # still finds the volume when COMPOSE_PROJECT_NAME has mixed case.
  project="$(printf '%s' "${project}" | tr '[:upper:]' '[:lower:]')"
  vol="${project}_db-data"
  if docker volume inspect "${vol}" >/dev/null 2>&1; then
    warn "A Postgres data volume named '${vol}' already exists, but POSTGRES_PASSWORD in ${ENV_FILE} is unset/placeholder — this run is about to generate a brand-new one. Postgres only applies a password on first init of an EMPTY data directory, so if '${vol}' holds data from a prior/different instance, the new password will NOT match what's already baked into it, and the app will fail with 'password authentication failed for user ... (28P01)'. This script will NOT touch the volume — that decision is yours: if '${vol}' is stale (left over from a previous or deleted instance), remove it first — 'docker compose down -v' run from this stack's directory, or 'docker volume rm ${vol}' — then re-run this script. If it's actually the correct, already-initialized volume for THIS instance, stop here and set POSTGRES_PASSWORD in ${ENV_FILE} to match its real password instead of letting this script generate a new one. See docs/setup-runbook.md, 'Completely removing / reinstalling osshp'."
  fi
}

current_pg="$(osshp_get_env "${ENV_FILE}" POSTGRES_PASSWORD)"
if is_placeholder "${current_pg}"; then
  osshp_warn_if_stale_db_volume
  backup_once "${ENV_FILE}"
  new_pg="$(openssl rand -hex 24)"
  old_pg_for_url="${current_pg}"
  [ -z "${old_pg_for_url}" ] && old_pg_for_url="CHANGE_ME"
  osshp_set_env "${ENV_FILE}" POSTGRES_PASSWORD "${new_pg}"

  db_url="$(osshp_get_env "${ENV_FILE}" DATABASE_URL)"
  needle=":${old_pg_for_url}@"
  if printf '%s' "${db_url}" | grep -qF "${needle}"; then
    replaced="${db_url/${needle}/:${new_pg}@}"
    osshp_set_env "${ENV_FILE}" DATABASE_URL "${replaced}"
    GENERATED+=("POSTGRES_PASSWORD (+ substituted into DATABASE_URL)")
  else
    warn "DATABASE_URL does not contain the expected ':${old_pg_for_url}@' placeholder — leaving DATABASE_URL untouched. If it doesn't already match the new POSTGRES_PASSWORD, update it by hand."
    GENERATED+=("POSTGRES_PASSWORD (DATABASE_URL left untouched — see warning above)")
  fi
else
  PRESERVED+=("POSTGRES_PASSWORD (+ DATABASE_URL) — already set")
fi

# ============================================================================
# Garage object storage provisioning
# ============================================================================

s3_access="$(osshp_get_env "${ENV_FILE}" S3_ACCESS_KEY)"
s3_secret="$(osshp_get_env "${ENV_FILE}" S3_SECRET_KEY)"

if ! is_placeholder "${s3_access}" && ! is_placeholder "${s3_secret}"; then
  PRESERVED+=("Garage provisioning — S3_ACCESS_KEY/S3_SECRET_KEY already set, skipped")
else
  info "Provisioning Garage object storage..."
  info "Bringing up db + storage..."
  "${COMPOSE[@]}" up -d db storage >/dev/null

  storage_cid="$("${COMPOSE[@]}" ps -q storage)"
  [ -n "${storage_cid}" ] || die "Could not find the storage container after 'docker compose up -d storage'."

  info "Waiting for Garage RPC to come up..."
  first_node_row=""
  attempt=0
  while [ -z "${first_node_row}" ]; do
    attempt=$((attempt + 1))
    [ "${attempt}" -le 30 ] \
      || die "Garage did not become reachable after 30s. Check 'docker compose logs storage'."
    first_node_row="$(docker exec "${storage_cid}" /garage status 2>/dev/null \
      | awk '/HEALTHY NODES/{f=1; c=0; next} f{c++; if(c==2){print; exit}}' || true)"
    [ -n "${first_node_row}" ] || sleep 1
  done
  node_id="$(printf '%s\n' "${first_node_row}" | awk '{print $1}')"
  [ -n "${node_id}" ] || die "Could not determine the Garage node ID from 'garage status' output."
  info "Garage node ID: ${node_id}"

  layout_output="$(docker exec "${storage_cid}" /garage layout show 2>/dev/null)"
  if printf '%s\n' "${layout_output}" | grep -qF "${node_id}"; then
    info "Garage layout already assigned for this node — skipping layout assign/apply."
  else
    info "Assigning Garage storage layout..."
    current_version="$(printf '%s\n' "${layout_output}" \
      | sed -nE 's/^Current cluster layout version: ([0-9]+)$/\1/p')"
    current_version="${current_version:-0}"
    next_version=$((current_version + 1))
    docker exec "${storage_cid}" /garage layout assign -z dc1 -c 1G "${node_id}" >/dev/null \
      || die "Garage layout assign failed."
    docker exec "${storage_cid}" /garage layout apply --version "${next_version}" >/dev/null \
      || die "Garage layout apply failed."
  fi

  bucket_output="$(docker exec "${storage_cid}" /garage bucket list 2>/dev/null)"
  if printf '%s\n' "${bucket_output}" | grep -qF "osshp-media"; then
    info "Bucket 'osshp-media' already exists — skipping create."
  else
    info "Creating bucket 'osshp-media'..."
    docker exec "${storage_cid}" /garage bucket create osshp-media >/dev/null \
      || die "Garage bucket create failed."
  fi

  key_output="$(docker exec "${storage_cid}" /garage key list 2>/dev/null)"
  key_name="osshp-app-key"
  if printf '%s\n' "${key_output}" | grep -qF "osshp-app-key"; then
    key_name="osshp-app-key-$(date -u +%Y%m%dT%H%M%SZ)"
    warn "A Garage key named 'osshp-app-key' already exists but S3_ACCESS_KEY/S3_SECRET_KEY are not set in .env — its secret cannot be retrieved (Garage shows a key's secret only once, at creation). Creating a new key '${key_name}' instead. The old key is left in place; delete it by hand with 'docker exec ${storage_cid} /garage key delete <key-id>' once you've confirmed it's unused."
  fi

  info "Creating access key '${key_name}'..."
  key_create_output="$(docker exec "${storage_cid}" /garage key create "${key_name}" 2>&1)"
  key_id="$(printf '%s\n' "${key_create_output}" | sed -nE 's/^Key ID:[[:space:]]*(.*)$/\1/p' | head -1)"
  key_secret="$(printf '%s\n' "${key_create_output}" | sed -nE 's/^Secret key:[[:space:]]*(.*)$/\1/p' | head -1)"
  if [ -z "${key_id}" ] || [ -z "${key_secret}" ]; then
    die "Could not parse the new Garage key's ID/secret from 'garage key create' output. Nothing was written to .env — re-run ./scripts/setup.sh, or provision manually per docs/setup-runbook.md. Raw output was:
${key_create_output}"
  fi

  info "Granting read/write/owner on 'osshp-media' to '${key_name}'..."
  docker exec "${storage_cid}" /garage bucket allow --read --write --owner osshp-media --key "${key_id}" >/dev/null \
    || die "Garage bucket allow failed."

  backup_once "${ENV_FILE}"
  osshp_set_env "${ENV_FILE}" S3_ACCESS_KEY "${key_id}"
  osshp_set_env "${ENV_FILE}" S3_SECRET_KEY "${key_secret}"
  GENERATED+=("S3_ACCESS_KEY / S3_SECRET_KEY (Garage key '${key_name}')")

  info "Recreating app to pick up the new S3 credentials..."
  "${COMPOSE[@]}" up -d --force-recreate app >/dev/null
fi

# ============================================================================
# Bring the whole stack up
# ============================================================================

if [ "${PULL_MODE}" = true ]; then
  info "Pulling the published app image..."
  "${COMPOSE[@]}" pull app >/dev/null
fi

info "Starting the full stack..."
"${COMPOSE[@]}" up -d >/dev/null

info "Waiting for the app to become healthy (up to 60s)..."
app_cid="$("${COMPOSE[@]}" ps -q app || true)"
healthy=false
if [ -n "${app_cid}" ]; then
  i=0
  while [ "${i}" -lt 60 ]; do
    i=$((i + 1))
    h="$(docker inspect --format '{{.State.Health.Status}}' "${app_cid}" 2>/dev/null || true)"
    if [ "${h}" = "healthy" ]; then
      healthy=true
      break
    fi
    sleep 1
  done
fi
if [ "${healthy}" = true ]; then
  info "app is healthy."
else
  warn "app did not report healthy within 60s. This can be a weak/placeholder secret or a DATABASE_URL/POSTGRES_PASSWORD mismatch (both fail closed — the app stays up and serves HTTP 500 rather than crashing). Check 'docker compose logs app' and docs/setup-runbook.md's troubleshooting table."
fi

# ============================================================================
# Summary
# ============================================================================

echo ""
echo "======================================================================"
echo " osshp setup summary"
echo "======================================================================"
if [ "${#GENERATED[@]}" -gt 0 ]; then
  echo "Generated (new):"
  for g in "${GENERATED[@]}"; do echo "  - ${g}"; done
else
  echo "Generated (new): none"
fi
echo ""
if [ "${#PRESERVED[@]}" -gt 0 ]; then
  echo "Preserved (already configured, left untouched):"
  for p in "${PRESERVED[@]}"; do echo "  - ${p}"; done
else
  echo "Preserved (already configured, left untouched): none"
fi
echo ""
if [ "${ENV_BACKED_UP}" = true ] || [ "${GARAGE_BACKED_UP}" = true ]; then
  echo "Backups written this run:"
  [ "${ENV_BACKED_UP}" = true ] && echo "  - ${ENV_FILE}.bak-* "
  [ "${GARAGE_BACKED_UP}" = true ] && echo "  - ${GARAGE_TOML}.bak-* "
else
  echo "Backups written this run: none (nothing existing was modified)"
fi
echo ""
echo "Deployment mode: ${DEPLOY_MODE}"
if [ "${DEPLOY_MODE}" = tunnel ]; then
  echo ""
  echo "Cloudflare Tunnel mode — the osshp side is configured and the stack"
  echo "(incl. the cloudflared connector) is up. Finish on the Cloudflare side"
  echo "if you have not already (this script does NOT automate it):"
  echo "  1. In the Zero Trust dashboard, open your tunnel and add a Public"
  echo "     Hostname for ${domain} with Service Type=HTTP, URL=proxy:80"
  echo "     (i.e. http://proxy:80). 'proxy' is the compose SERVICE name —"
  echo "     NOT osshp (project/stack name), NOT osshp-proxy-1 (container"
  echo "     name), NOT localhost, NOT an IP. DNS auto-creates on save."
  echo "  2. Confirm the connector is live:  cloudflared tunnel list"
  echo "     (or 'docker compose ${COMPOSE_FILES[*]} logs cloudflared')."
  echo ""
  echo "Canonical up command for this instance (needs BOTH -f flags every time):"
  echo "  docker compose ${COMPOSE_FILES[*]} up -d"
fi
echo ""
echo "Next: open https://${domain} and complete the setup wizard."
echo "Full reference: docs/setup-runbook.md"
