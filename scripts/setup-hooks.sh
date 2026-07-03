#!/usr/bin/env bash
# Install the osshp pre-push validation gate into .git/hooks/
#
# Run once after cloning: bash osshp/scripts/setup-hooks.sh
#
# If a pre-push hook already exists, this script appends a call to the
# osshp gate rather than replacing the existing hook.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK_DIR="$REPO_ROOT/.git/hooks"
HOOK_FILE="$HOOK_DIR/pre-push"
OSSHP_GATE="$REPO_ROOT/osshp/scripts/pre-push"

if [[ ! -d "$HOOK_DIR" ]]; then
  echo "Error: .git/hooks not found at $HOOK_DIR" >&2
  exit 1
fi

chmod +x "$OSSHP_GATE"

if [[ -f "$HOOK_FILE" ]] && grep -q "osshp" "$HOOK_FILE" 2>/dev/null; then
  echo "[setup-hooks] osshp pre-push gate already installed — nothing to do."
  exit 0
fi

if [[ -f "$HOOK_FILE" ]]; then
  # Append to existing hook
  echo "" >> "$HOOK_FILE"
  echo "# osshp pre-push gate" >> "$HOOK_FILE"
  echo "\"$OSSHP_GATE\"" >> "$HOOK_FILE"
  echo "[setup-hooks] Appended osshp gate to existing pre-push hook."
else
  # Create new hook
  cat > "$HOOK_FILE" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
HOOK

  echo "" >> "$HOOK_FILE"
  echo "# osshp pre-push gate" >> "$HOOK_FILE"
  echo "\"$OSSHP_GATE\"" >> "$HOOK_FILE"
  chmod +x "$HOOK_FILE"
  echo "[setup-hooks] Installed osshp pre-push hook at $HOOK_FILE"
fi
