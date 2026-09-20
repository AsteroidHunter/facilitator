#!/usr/bin/env bash
# Remove this checkout's installed files and owned shell integration.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$REPO/facilitator" uninstall "$@"
