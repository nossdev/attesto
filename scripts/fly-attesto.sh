#!/usr/bin/env bash
# Wrapper for SSH-execing the deployed `attesto` admin CLI on Fly.
#
# Pulls three concerns out of the per-task mise.toml runs:
#   1. Target validation — `staging` / `prod` only, errors on typos
#      (the dangerous direction is "operator typed `prd` and we silently
#      ran on staging while they thought it was prod" — fail loud on that).
#   2. App-name resolution — staging → attesto-staging, prod → attesto.
#   3. Safe arg escaping across the local-shell → fly-ssh → remote-sh
#      boundary using printf %q, so values with apostrophes / spaces /
#      other shell metacharacters survive intact (e.g. tenant name
#      "O'Brien Health" doesn't break the inner quoting).
#
# Usage: scripts/fly-attesto.sh <staging|prod> <attesto-cli-args...>
# Example: scripts/fly-attesto.sh staging webhook:get tenant_01HXY...

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <staging|prod> <attesto-cli-args...>" >&2
  exit 2
fi

TARGET="$1"
shift

case "$TARGET" in
  staging) APP="attesto-staging" ;;
  prod)    APP="attesto" ;;
  *)       echo "error: target must be 'staging' or 'prod' (got '$TARGET')" >&2; exit 2 ;;
esac

# Build the remote command, escaping each argv with printf %q so the remote
# shell sees the values back as single arguments — no inner-quoting tricks.
REMOTE_CMD="attesto"
for arg in "$@"; do
  REMOTE_CMD+=" $(printf '%q' "$arg")"
done

exec fly ssh console -a "$APP" --command "$REMOTE_CMD"
