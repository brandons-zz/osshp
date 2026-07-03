#!/usr/bin/env bash
# backup.sh — Full-site backup for an osshp instance.
#
# Produces a single encrypted archive containing everything needed to
# restore a working instance on this host or a new one:
#   - Postgres content (pg_dump, custom format, taken live — no downtime)
#   - Garage object storage (data + meta volumes — includes bucket/key/
#     layout config, not just object bytes, so restore needs no manual
#     Garage re-provisioning)
#   - .env and config/garage.toml (operator secrets: SESSION_SECRET,
#     OSSHP_ENCRYPTION_KEY, POSTGRES_PASSWORD, S3 keys, Garage RPC secret)
#   - manifest.json (backup timestamp, source commit, image/version info)
#
# SECURITY: The archive contains every secret this instance holds,
# including OSSHP_ENCRYPTION_KEY — the key that decrypts TOTP secrets
# already inside the Postgres dump. Without it those TOTP secrets are
# permanently unreadable after restore. The archive is therefore AT LEAST
# as sensitive as .env and is encrypted at rest with a passphrase you
# supply. Store the passphrase separately from the archive (a password
# manager, not next to the backup file) — anyone with both can fully
# impersonate this instance's admin.
#
# SECURITY (integrity, authenticated encryption): the archive is
# encrypted with age (https://age-encryption.org) in passphrase mode —
# an AEAD construction (scrypt-derived key + ChaCha20-Poly1305), so
# integrity is intrinsic to the ciphertext itself. There is no separate
# HMAC sidecar to keep track of: a corrupted or tampered archive, or a
# wrong passphrase, is rejected by `age` itself, atomically, before it
# ever writes output — restore.sh never extracts or acts on anything
# from ciphertext that failed authentication.
#
# SECURITY (no secret on argv): neither the passphrase nor any derived
# key is ever placed on any process's command line. `age`'s own -p
# prompt is real terminal I/O with no argv/env/stdin path at all
# (deliberate upstream design). For interactive runs, `age` prompts
# directly on the real terminal and the passphrase never enters this
# script's memory. For non-interactive runs (BACKUP_PASSPHRASE set —
# cron, scripted DR), the passphrase is bridged into that same prompt
# through a real pseudo-terminal via `scripts/lib/age-pty.exp`: it goes
# environment variable -> Tcl interpreter memory -> pty, never argv,
# never a temp file. See docs/backup-restore.md "Delivery channel" for
# the full writeup, including why BACKUP_PASSPHRASE-as-env-var (not a
# stdin/fd convention) is the unavoidable channel for the cron case.
#
# SECURITY (no plaintext on disk): the staged archive is streamed
# directly into `age` — a plaintext tar of the staged content is never
# written to disk, on success or failure. `umask 077` is set for the
# duration of the run as defense in depth for the staged files
# themselves (db.dump, env.backup, etc., which briefly exist under
# backups/.staging-* while being tarred).
#
# Usage:
#   BACKUP_PASSPHRASE='...' ./scripts/backup.sh        # non-interactive (cron)
#   ./scripts/backup.sh                                 # prompts for passphrase
#
# Output: backups/osshp-backup-<UTC-timestamp>.tar.age (gitignored)
#         (single file — no integrity sidecar; age's AEAD makes one
#         unnecessary. Earlier versions of this script produced a
#         .tar.enc + .tar.enc.hmac pair; that format is not written or
#         read by this version — see docs/backup-restore.md "Old-format
#         archives" if you have one from before this change.)
#
# Requires: docker compose (stack running), age, tar, and — for
# non-interactive/cron runs only — expect. Garage's storage container is
# briefly stopped and restarted during the volume snapshot — media
# requests (/media/[...key]) fail for that window; the public site,
# admin console, and Postgres content are unaffected throughout.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSSHP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE="docker compose -f ${OSSHP_DIR}/docker-compose.yml --project-directory ${OSSHP_DIR}"
# Digest-pinned per the M2.6 supply-chain convention (see docker-compose.yml).
# To bump: docker pull alpine:3 && docker inspect alpine:3 --format '{{index .RepoDigests 0}}'
BACKUP_HELPER_IMAGE="alpine:3@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b"
# age is a host binary, not a pinned container image (it runs directly
# against staged files, same as tar/git). Tested against age v1.3.1 —
# any 1.x release is expected to work (the -p/-o/positional-INPUT
# surface this script depends on has been stable since age v1.0.0). See
# docs/backup-restore.md "Installing age" for install + verification
# instructions and the pinned-version rationale.
MIN_AGE_MAJOR=1

info()  { echo "[backup] $*"; }
warn()  { echo "[backup] WARNING: $*" >&2; }
fail()  { echo "[backup] ERROR: $*" >&2; exit 1; }

cd "${OSSHP_DIR}"

[ -f .env ] || fail ".env not found at ${OSSHP_DIR}/.env — nothing to back up."
set -a
# shellcheck disable=SC1091
. ./.env
set +a

POSTGRES_USER="${POSTGRES_USER:-osshp}"
POSTGRES_DB="${POSTGRES_DB:-osshp}"

# ---- dependency checks ---------------------------------------------------------
command -v age >/dev/null 2>&1 || fail "age not found on PATH. Install it (apt/dnf/apk package 'age', 'brew install age', or a pinned release binary) — see docs/backup-restore.md 'Installing age'."
AGE_VERSION_RAW="$(age --version 2>/dev/null || echo unknown)"
info "Using age ${AGE_VERSION_RAW}"
case "${AGE_VERSION_RAW}" in
  v[0-9]*)
    AGE_MAJOR="${AGE_VERSION_RAW#v}"
    AGE_MAJOR="${AGE_MAJOR%%.*}"
    if [ "${AGE_MAJOR}" -lt "${MIN_AGE_MAJOR}" ] 2>/dev/null; then
      warn "age ${AGE_VERSION_RAW} is older than the tested baseline (v${MIN_AGE_MAJOR}.x) — proceeding, but consider upgrading."
    fi
    ;;
  *)
    warn "Could not parse age's version string ('${AGE_VERSION_RAW}') — proceeding anyway."
    ;;
esac

# ---- passphrase / delivery mode ------------------------------------------------
# Fail loud rather than ever writing an unencrypted archive to disk.
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  if [ -t 0 ]; then
    MODE="interactive"
  else
    fail "BACKUP_PASSPHRASE not set and stdin is not a TTY (non-interactive run). Set BACKUP_PASSPHRASE explicitly."
  fi
else
  MODE="noninteractive"
  command -v expect >/dev/null 2>&1 || fail "expect not found on PATH. It is required to deliver BACKUP_PASSPHRASE to age's terminal-only passphrase prompt without a real terminal present (cron/scripted runs) — install it (apt/dnf/apk/brew package 'expect'). See docs/backup-restore.md 'Delivery channel'."
fi

# ---- sweep stale plaintext from any prior crashed/interrupted run ------------
# Belt-and-braces: a run killed between writing a staging file and the EXIT
# trap running (SIGKILL, power loss) cannot clean up after itself. Sweep any
# leftovers from this or a prior run, including the pre-age plaintext-staging
# window an earlier version of this script had.
BACKUP_DIR="${OSSHP_DIR}/backups"
if [ -d "${BACKUP_DIR}" ]; then
  shopt -s nullglob
  stale_staging=("${BACKUP_DIR}"/.staging-*)
  stale_plain=("${BACKUP_DIR}"/.osshp-backup-*.tar)
  shopt -u nullglob
  if [ "${#stale_staging[@]}" -gt 0 ] || [ "${#stale_plain[@]}" -gt 0 ]; then
    warn "Removing stale plaintext leftovers from a prior interrupted run:"
    for f in "${stale_staging[@]}" "${stale_plain[@]}"; do
      warn "  ${f}"
      rm -rf "${f}"
    done
  fi
fi

# ---- staging ------------------------------------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="${BACKUP_DIR}/.staging-${TS}"
mkdir -p "${STAGING}"
OUT_FILE=""
BACKUP_SUCCESS=0
cleanup() {
  rm -rf "${STAGING}"
  # Belt-and-braces: if age (or the tar feeding it) dies mid-stream, a
  # partial ciphertext file may have been opened/truncated by -o before
  # the failure. It is never plaintext (streamed straight from tar into
  # age — see "archive + encrypt" below), but a half-written "backup"
  # sitting in backups/ is misleading litter, so remove it unless the run
  # completed successfully end-to-end.
  if [ "${BACKUP_SUCCESS}" -ne 1 ]; then
    [ -n "${OUT_FILE}" ] && rm -f "${OUT_FILE}"
  fi
}
trap cleanup EXIT

info "Starting backup ${TS}"

# ---- 1. Postgres content (live, no downtime) -----------------------------------
info "Dumping Postgres (${POSTGRES_DB})..."
${COMPOSE} exec -T db pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -Fc > "${STAGING}/db.dump"
[ -s "${STAGING}/db.dump" ] || fail "pg_dump produced an empty file."
info "Postgres dump: $(du -h "${STAGING}/db.dump" | cut -f1)"

# ---- 2. Garage object storage (data + meta volumes, brief stop) ---------------
# Volume-level snapshot (not S3 API sync) so bucket/key/layout config comes
# back atomically on restore — no manual `garage bucket create` / `garage key
# import` reconciliation needed, and no risk of node-ID mismatch on a fresh
# host. Garage's embedded metadata store must not be copied while the daemon
# is writing to it (same corruption class as a live SQLite/WAL file copy), so
# the storage container is stopped for the duration of the tar.
info "Stopping storage container for a consistent volume snapshot..."
${COMPOSE} stop storage >/dev/null

info "Snapshotting Garage volumes (garage-data, garage-meta)..."
docker run --rm \
  -v osshp_garage-data:/snap/data:ro \
  -v osshp_garage-meta:/snap/meta:ro \
  -v "${STAGING}:/backup" \
  ${BACKUP_HELPER_IMAGE} \
  tar czf /backup/garage-volumes.tar.gz -C /snap data meta

info "Restarting storage container..."
${COMPOSE} start storage >/dev/null
info "Garage volumes: $(du -h "${STAGING}/garage-volumes.tar.gz" | cut -f1)"

# ---- 3. Operator secrets/config ------------------------------------------------
cp "${OSSHP_DIR}/.env" "${STAGING}/env.backup"
if [ -f "${OSSHP_DIR}/config/garage.toml" ]; then
  cp "${OSSHP_DIR}/config/garage.toml" "${STAGING}/garage.toml.backup"
else
  warn "config/garage.toml not found — restore to a fresh host will need it re-created."
fi

# ---- 4. Manifest ---------------------------------------------------------------
GIT_SHA="$(git -C "${OSSHP_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)"
IMAGE_REF="$(docker inspect --format '{{.Image}}' osshp-app-1 2>/dev/null || echo unknown)"
cat > "${STAGING}/manifest.json" <<EOF
{
  "created_at_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "osshp_commit": "${GIT_SHA}",
  "app_image_id": "${IMAGE_REF}",
  "postgres_db": "${POSTGRES_DB}",
  "s3_bucket": "${S3_BUCKET:-osshp-media}",
  "backup_tool_version": 3
}
EOF

# ---- 5. Archive + encrypt (streamed — no plaintext ever touches disk) ----------
mkdir -p "${BACKUP_DIR}"
OUT_FILE="${BACKUP_DIR}/osshp-backup-${TS}.tar.age"

info "Archiving + encrypting (age, passphrase mode, streamed — no plaintext archive on disk)..."
if [ "${MODE}" = "interactive" ]; then
  # age prompts directly on the real terminal (twice, entry + confirm).
  # The passphrase never enters this script's own memory or environment.
  tar cf - -C "${STAGING}" . | age -p -o "${OUT_FILE}"
else
  # Non-interactive: bridge BACKUP_PASSPHRASE into age's terminal-only
  # prompt via a real pty (see scripts/lib/age-pty.exp header for why).
  AGE_CMD="tar cf - -C '${STAGING}' . | age -p -o '${OUT_FILE}'"
  expect "${SCRIPT_DIR}/lib/age-pty.exp" enc "${AGE_CMD}"
fi
chmod 600 "${OUT_FILE}"
[ -s "${OUT_FILE}" ] || fail "age produced an empty output file."

BACKUP_SUCCESS=1
info "Backup complete: ${OUT_FILE} ($(du -h "${OUT_FILE}" | cut -f1))"
info "This file contains every secret this instance holds. Store the"
info "passphrase separately (never alongside the backup file itself)."
