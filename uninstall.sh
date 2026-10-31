#!/usr/bin/env bash
# Remove this checkout's installed files and owned shell integration. The
# board's data goes only after a no and then a yes to "Are you sure?".
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$REPO/facilitator" uninstall "$@"
