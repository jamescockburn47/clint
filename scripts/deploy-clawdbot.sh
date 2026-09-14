#!/usr/bin/env bash
# Retired: the old deployment script changed unrelated model services.
set -euo pipefail
if [ "${1:-}" = "--verify" ]; then
  cd "$(dirname "$0")/.."
  exec npm run verify
fi
printf '%s\n' 'Deployment requires an approved release. Follow docs/release-runbook.md.' >&2
exit 2
