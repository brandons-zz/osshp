#!/usr/bin/env bash
# setup.sh — First-run setup for the osshp stack.
#
# Creates config/garage.toml and .env from their examples if they do not
# already exist, then reminds the operator to fill in CHANGE_ME values.
#
# Usage: ./scripts/setup.sh   (run from the osshp/ directory)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

# ---- helpers ----------------------------------------------------------------

info()  { echo "[setup] $*"; }
warn()  { echo "[setup] WARNING: $*" >&2; }

# ---- config/garage.toml -----------------------------------------------------

GARAGE_TOML="config/garage.toml"
GARAGE_EXAMPLE="config/garage.toml.example"

if [ -d "${GARAGE_TOML}" ]; then
  warn "${GARAGE_TOML} is a directory (Docker auto-created it). Removing stale dir."
  rmdir "${GARAGE_TOML}"
fi

if [ ! -f "${GARAGE_TOML}" ]; then
  cp "${GARAGE_EXAMPLE}" "${GARAGE_TOML}"
  info "Created ${GARAGE_TOML} from example."
  info "  --> Edit ${GARAGE_TOML}: set rpc_secret to a 64-char hex string."
  info "      Generate with: openssl rand -hex 32"
else
  info "${GARAGE_TOML} already exists — skipping."
fi

# ---- .env -------------------------------------------------------------------

ENV_FILE=".env"
ENV_EXAMPLE=".env.example"

if [ ! -f "${ENV_FILE}" ]; then
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
  info "Created ${ENV_FILE} from example."
  info "  --> Edit .env: fill in every CHANGE_ME value before running the stack."
else
  info "${ENV_FILE} already exists — skipping."
fi

# ---- summary ----------------------------------------------------------------

echo ""
echo "Setup complete. Next steps:"
echo "  1. Fill in CHANGE_ME values in config/garage.toml and .env"
echo "  2. docker compose up -d"
echo "  3. Follow docs/setup-runbook.md for Garage key provisioning"
