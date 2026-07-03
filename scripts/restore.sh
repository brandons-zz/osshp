#!/usr/bin/env bash
# restore.sh — Restore an osshp instance from a backup.sh archive.
#
# DESTRUCTIVE: replaces the current Postgres database and Garage volumes
# with the contents of the backup. Existing .env / config/garage.toml are
# overwritten with the backed-up versions (so the restored instance's
# secrets match the data it's being restored with — required, since
# OSSHP_ENCRYPTION_KEY must match the TOTP secrets already in the dump).
# Confirms before acting unless --yes is passed.
#
# SECURITY (integrity, authenticated encryption): the archive is
# encrypted with age (https://age-encryption.org) in passphrase mode — an
# AEAD construction, so decryption itself IS the integrity check. There
# is no separate pre-decrypt verification step (there is no HMAC sidecar
# to check): `age -d` atomically fails closed — writing nothing — on a
# wrong passphrase or any tampered/corrupted byte anywhere in the
# archive. Because decrypt+extract happens before the manifest is shown,
# before the confirmation prompt, and long before any destructive
# restore step (DB drop, volume replace, `.env` overwrite), a failed
# authentication check aborts the whole script at that point via
# `set -euo pipefail` — nothing past it ever runs, including under
# `--yes`.
#
# Works for two scenarios:
#   - Same/existing host, recovering from data loss: stack is already
#     deployed; this replaces its data + secrets in place.
#   - Fresh host, migrating: run `docker compose up -d db storage` once
#     first (creates empty volumes/network for this script to populate),
#     then run this script, then `docker compose up -d` for the rest.
#     Garage's node identity, layout, bucket, and key all come back from
#     the meta-volume snapshot — no manual `garage bucket create` /
#     `garage key import` steps needed.
#
# Usage:
#   BACKUP_PASSPHRASE='...' ./scripts/restore.sh <backup-file.tar.age> [--yes]
#   ./scripts/restore.sh <backup-file.tar.age>          # prompts for passphrase + confirmation
#
# NOTE (old-format archives): this version only reads the `.tar.age`
# format. Archives produced before this change (`.tar.enc` +
# `.tar.enc.hmac`, AES-256-CBC + a separate HMAC sidecar) are not
# accepted here — see docs/backup-restore.md "Old-format archives" for
# how to decrypt one by hand if you have one.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSSHP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE="docker compose -f ${OSSHP_DIR}/docker-compose.yml --project-directory ${OSSHP_DIR}"
# Digest-pinned per the M2.6 supply-chain convention (see docker-compose.yml).
# To bump: docker pull alpine:3 && docker inspect alpine:3 --format '{{index .RepoDigests 0}}'
BACKUP_HELPER_IMAGE="alpine:3@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b"

info()  { echo "[restore] $*"; }
warn()  { echo "[restore] WARNING: $*" >&2; }
fail()  { echo "[restore] ERROR: $*" >&2; exit 1; }

cd "${OSSHP_DIR}"

BACKUP_FILE="${1:-}"
ASSUME_YES=0
for arg in "$@"; do
  [ "${arg}" = "--yes" ] && ASSUME_YES=1
done

[ -n "${BACKUP_FILE}" ] || fail "Usage: restore.sh <backup-file.tar.age> [--yes]"
[ -f "${BACKUP_FILE}" ] || fail "Backup file not found: ${BACKUP_FILE}"
BACKUP_FILE="$(cd "$(dirname "${BACKUP_FILE}")" && pwd)/$(basename "${BACKUP_FILE}")"

case "${BACKUP_FILE}" in
  *.tar.enc)
    fail "This looks like an old-format archive (.tar.enc, AES-256-CBC + separate .hmac sidecar). This version of restore.sh only reads the current .tar.age (age passphrase-mode AEAD) format. See docs/backup-restore.md 'Old-format archives' for how to decrypt an old archive by hand."
    ;;
esac

# ---- dependency checks ---------------------------------------------------------
command -v age >/dev/null 2>&1 || fail "age not found on PATH. Install it (apt/dnf/apk package 'age', 'brew install age', or a pinned release binary) — see docs/backup-restore.md 'Installing age'."
info "Using age $(age --version 2>/dev/null || echo unknown)"

# ---- passphrase / delivery mode ------------------------------------------------
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  if [ -t 0 ]; then
    MODE="interactive"
  else
    fail "BACKUP_PASSPHRASE not set and stdin is not a TTY. Set BACKUP_PASSPHRASE explicitly."
  fi
else
  MODE="noninteractive"
  command -v expect >/dev/null 2>&1 || fail "expect not found on PATH. It is required to deliver BACKUP_PASSPHRASE to age's terminal-only passphrase prompt without a real terminal present (--yes/scripted DR runs) — install it (apt/dnf/apk/brew package 'expect'). See docs/backup-restore.md 'Delivery channel'."
fi

# ---- integrity verification (PRE-EXTRACT — before any file is written) --------
# age's STREAM construction authenticates payload chunks as it decrypts,
# which means a chunk-based decrypt-and-extract pass alone could emit
# some early, individually-valid chunks as real files on disk before it
# reaches a tampered chunk later in the archive and aborts. To guarantee
# "no extraction before authentication" (not just "no destructive step
# before authentication"), this script makes a first, extraction-free
# pass: decrypt the WHOLE archive to /dev/null. Only once that full pass
# succeeds — proving every chunk in the archive authenticates against
# this passphrase — does the second pass actually extract anything. Both
# passes are the same `age -d` operation; there is no separate mechanism
# or sidecar, just an ordering guarantee around the one AEAD check age
# already does.
TS="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="${OSSHP_DIR}/backups/.restore-staging-${TS}"
EXTRACTED="${STAGING}/extracted"
mkdir -p "${EXTRACTED}"
trap 'rm -rf "${STAGING}"' EXIT

info "Verifying archive authenticity (full pass, no extraction yet)..."
set +e
if [ "${MODE}" = "interactive" ]; then
  # age prompts directly on the real terminal (once). The passphrase
  # never enters this script's own memory or environment.
  age -d "${BACKUP_FILE}" > /dev/null 2>"${STAGING}/age-verify.stderr"
  VERIFY_RC=$?
else
  # Non-interactive: bridge BACKUP_PASSPHRASE into age's terminal-only
  # prompt via a real pty (see scripts/lib/age-pty.exp header for why).
  VERIFY_CMD="age -d '${BACKUP_FILE}' > /dev/null 2>'${STAGING}/age-verify.stderr'"
  expect "${SCRIPT_DIR}/lib/age-pty.exp" dec "${VERIFY_CMD}"
  VERIFY_RC=$?
fi
set -e

if [ "${VERIFY_RC}" -ne 0 ]; then
  fail "Decryption failed — wrong passphrase, or the archive is corrupted or tampered with. Refusing to restore anything.$( [ -s "${STAGING}/age-verify.stderr" ] && echo " ($(cat "${STAGING}/age-verify.stderr"))" )"
fi
info "Archive authenticated — decrypting + extracting..."

info "Decrypting + extracting ${BACKUP_FILE}..."
set +e
if [ "${MODE}" = "interactive" ]; then
  age -d "${BACKUP_FILE}" 2>"${STAGING}/age.stderr" | tar xf - -C "${EXTRACTED}" 2>"${STAGING}/tar.stderr"
  PIPE_STATUS=("${PIPESTATUS[@]}")
else
  AGE_CMD="age -d '${BACKUP_FILE}' 2>'${STAGING}/age.stderr' | tar xf - -C '${EXTRACTED}' 2>'${STAGING}/tar.stderr'; s=(\"\${PIPESTATUS[@]}\"); echo \"\${s[0]} \${s[1]}\" > '${STAGING}/pipestatus'; [ \"\${s[0]}\" -eq 0 ] && [ \"\${s[1]}\" -eq 0 ]"
  expect "${SCRIPT_DIR}/lib/age-pty.exp" dec "${AGE_CMD}"
  EXPECT_RC=$?
  if [ -f "${STAGING}/pipestatus" ]; then
    read -r p0 p1 < "${STAGING}/pipestatus"
    PIPE_STATUS=("${p0}" "${p1}")
  else
    PIPE_STATUS=("${EXPECT_RC:-1}" 0)
  fi
fi
set -e

if [ "${PIPE_STATUS[0]}" -ne 0 ] || [ "${PIPE_STATUS[1]}" -ne 0 ]; then
  fail "Unexpected failure during extraction, even though the archive already passed authentication above. Aborting — this should not happen; please report it."
fi
info "Decryption + extraction succeeded — archive is authentic and unmodified."

for required in db.dump garage-volumes.tar.gz env.backup manifest.json; do
  [ -f "${EXTRACTED}/${required}" ] || fail "Archive missing expected file: ${required} — not a valid osshp backup."
done

info "Backup manifest:"
cat "${EXTRACTED}/manifest.json" | sed 's/^/[restore]   /'

# ---- confirm --------------------------------------------------------------------
if [ "${ASSUME_YES}" -ne 1 ]; then
  echo ""
  echo "This will REPLACE the current database and object storage with the"
  echo "backup above, and overwrite .env / config/garage.toml. This cannot"
  echo "be undone unless you have a separate backup of the current state."
  read -r -p "Type 'restore' to continue: " CONFIRM
  [ "${CONFIRM}" = "restore" ] || fail "Aborted (confirmation not given)."
fi

# ---- restore secrets/config -----------------------------------------------------
info "Restoring .env and config/garage.toml..."
cp "${EXTRACTED}/env.backup" "${OSSHP_DIR}/.env"
if [ -f "${EXTRACTED}/garage.toml.backup" ]; then
  mkdir -p "${OSSHP_DIR}/config"
  cp "${EXTRACTED}/garage.toml.backup" "${OSSHP_DIR}/config/garage.toml"
fi

# Load the restored .env WITHOUT executing it as shell. The archive has now
# passed age's AEAD authentication (checked above, before extraction), so a
# tampered .env could not have reached this point undetected — but we still
# avoid `source`/`.` here as defense in depth: a plain KEY=VALUE reader
# can't be turned into code execution even if some future change
# reintroduces an unauthenticated path. Only lines matching a bare
# `NAME=value` shape are honored; comments and blanks are skipped; no
# expansion, command substitution, or quoting rules are interpreted.
osshp_load_env_file() {
  local file="$1" line key value
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line#"${line%%[![:space:]]*}"}"  # trim leading whitespace
    [ -z "${line}" ] && continue
    case "${line}" in
      '#'*) continue ;;
    esac
    case "${line}" in
      [A-Za-z_]*=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    case "${key}" in
      *[!A-Za-z0-9_]*) continue ;;
    esac
    # Strip one layer of matching surrounding quotes, if present.
    case "${value}" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    export "${key}=${value}"
  done < "${file}"
}
osshp_load_env_file "${OSSHP_DIR}/.env"
POSTGRES_USER="${POSTGRES_USER:-osshp}"
POSTGRES_DB="${POSTGRES_DB:-osshp}"

# ---- bring up db + storage (idempotent if already running) ---------------------
info "Ensuring db is up..."
${COMPOSE} up -d db >/dev/null
info "Waiting for Postgres to be healthy..."
for _ in $(seq 1 30); do
  if ${COMPOSE} exec -T db pg_isready -U "${POSTGRES_USER}" -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# ---- restore Postgres ------------------------------------------------------------
info "Stopping app (avoid writes during DB swap)..."
${COMPOSE} stop app >/dev/null 2>&1 || true

info "Dropping and recreating ${POSTGRES_DB}..."
${COMPOSE} exec -T db psql -U "${POSTGRES_USER}" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\" WITH (FORCE);" \
  -c "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";"

info "Restoring Postgres content..."
${COMPOSE} exec -T db pg_restore -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --no-owner < "${EXTRACTED}/db.dump"

# ---- restore Garage volumes -------------------------------------------------------
info "Stopping storage..."
${COMPOSE} stop storage >/dev/null 2>&1 || true

info "Replacing Garage volumes (garage-data, garage-meta) from snapshot..."
docker run --rm \
  -v osshp_garage-data:/live/data \
  -v osshp_garage-meta:/live/meta \
  -v "${EXTRACTED}:/backup:ro" \
  ${BACKUP_HELPER_IMAGE} \
  sh -c 'rm -rf /live/data/* /live/data/.[!.]* /live/meta/* /live/meta/.[!.]* 2>/dev/null; tar xzf /backup/garage-volumes.tar.gz -C /live'

info "Starting storage..."
${COMPOSE} up -d storage >/dev/null

info "Starting app..."
${COMPOSE} up -d app >/dev/null

# ---- verify -----------------------------------------------------------------------
info "Waiting for app health..."
OK=0
for _ in $(seq 1 30); do
  if ${COMPOSE} exec -T app wget -q --spider http://127.0.0.1:3000/api/health 2>/dev/null; then
    OK=1
    break
  fi
  sleep 2
done

if [ "${OK}" -eq 1 ]; then
  info "Restore complete. App is healthy."
else
  warn "Restore steps completed but app health check did not pass within timeout."
  warn "Check: ${COMPOSE} logs app"
fi

info "Verify Garage: ${COMPOSE} exec storage /garage status"
