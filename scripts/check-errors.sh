#!/usr/bin/env bash
# Fails if any FS-### code used in src/ or app/ is missing from ERRORS.md.
set -euo pipefail
cd "$(dirname "$0")/.."
missing=0
for code in $(grep -rhoE 'FS-[0-9]{3}' src app | sort -u); do
  if ! grep -q "^| \`$code\`" ERRORS.md; then
    echo "error: $code is used in the code but missing from ERRORS.md" >&2
    missing=1
  fi
done
[ "$missing" = 0 ] && echo "All error codes are documented in ERRORS.md."
exit "$missing"
