#!/usr/bin/env bash
# Linux counterpart of phase0-baseline.ps1. Upserts one row per calendar day
# into phase0_daily_baseline and exits non-zero unless that row came back.
set -Euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${CAREEROS_PG_CONTAINER:-careeros-postgres-1}"
LOG_FILE="$REPO_ROOT/logs/phase0-baseline.log"
mkdir -p "$REPO_ROOT/logs"

log() { local line; line="$(date '+%F %T') $*"; echo "$line"; echo "$line" >>"$LOG_FILE"; }

# stderr is dropped because psql writes a harmless NOTICE on every run; ON_ERROR_STOP
# still turns a real SQL error into a non-zero exit, which is what gets checked.
out="$(docker exec -i "$CONTAINER" psql -U careeros -d careeros -v ON_ERROR_STOP=1 -f - \
  <"$REPO_ROOT/scripts/phase0-baseline.sql" 2>/dev/null)"
code=$?
if (( code != 0 )); then
  log "ERROR psql exited $code"
  exit 1
fi

row="$(grep -E '^\s*[0-9]{4}-[0-9]{2}-[0-9]{2}\s*\|' <<<"$out" | tail -1 || true)"
if [[ -z "$row" ]]; then
  log "ERROR ran but no baseline row returned"
  exit 1
fi
log "collected: $(sed -E 's/^\s+//' <<<"$row")"
