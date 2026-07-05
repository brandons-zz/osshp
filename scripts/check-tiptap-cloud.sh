#!/usr/bin/env bash
# osshp compliance guard — Tiptap Cloud / Pro tier exclusion (library audit FLAG-2).
#
# The editor (M2.8) uses TipTap's MIT open-source packages ONLY (@tiptap/core,
# @tiptap/react, @tiptap/starter-kit, public @tiptap/extension-*). The Tiptap Cloud
# tier (collaboration, AI, comments, history) is PROPRIETARY and AGPL-3.0
# INCOMPATIBLE. This guard FAILS the build (non-zero exit) if any Cloud/Pro-tier
# package is imported or declared anywhere in the project.
#
# Wired into the local pre-push gate (osshp/scripts/pre-push) alongside the M2.6
# dependency-CVE scan — same gate surface, never per-commit GitHub CI.
#
# Usage: check-tiptap-cloud.sh [SCAN_ROOT]   (defaults to the app/ directory)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN_ROOT="${1:-$SCRIPT_DIR/../app}"

# Proprietary / AGPL-incompatible Tiptap Cloud + Pro tier surfaces:
#   @tiptap-pro/*      — Pro extensions (AI, comments, …)
#   @tiptap-cloud/*    — Tiptap Cloud SDK
#   @hocuspocus/*      — the collaboration backend the Cloud tier requires
#   @tiptap/extension-collaboration[-*]  — collaboration extensions (need Cloud/Hocuspocus)
FORBIDDEN='@tiptap-pro/|@tiptap-cloud/|@hocuspocus/|@tiptap/extension-collaboration'

echo "[tiptap guard] Scanning '$SCAN_ROOT' for Tiptap Cloud/Pro packages..."

# Scan source + dependency manifests; never node_modules/.next (a vendored package
# may legitimately reference these names internally — only OUR usage is a violation).
# Also exclude this guard's own test fixture file: it deliberately embeds the
# forbidden strings verbatim as planted-positive fixtures (see
# tiptap-cloud-guard.test.ts), and those fixtures are exercised by the test
# against a scoped temp scan-root, not the real tree — the raw fixture text
# living on disk under app/ should not also trip a whole-tree scan.
if matches=$(grep -REn "$FORBIDDEN" "$SCAN_ROOT" \
      --include='*.ts' --include='*.tsx' --include='*.js' \
      --include='*.mjs' --include='*.cjs' --include='*.json' --include='*.lock' \
      --exclude-dir=node_modules --exclude-dir=.next \
      --exclude='tiptap-cloud-guard.test.ts' 2>/dev/null); then
  echo "[tiptap guard] FAIL — Tiptap Cloud/Pro tier package(s) detected:" >&2
  echo "$matches" >&2
  echo "[tiptap guard] These are proprietary + AGPL-3.0 incompatible. Use TipTap's" >&2
  echo "[tiptap guard] MIT packages only (@tiptap/core, /react, /starter-kit, public" >&2
  echo "[tiptap guard] @tiptap/extension-*). Remove the offending import/dependency." >&2
  exit 1
fi

echo "[tiptap guard] PASS — no Tiptap Cloud/Pro tier packages present."
