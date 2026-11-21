#!/usr/bin/env bash
# Linux counterpart of verify-restore.ps1. Restores a dump into a throwaway
# container with no network, so the live database is never involved.
# Row counts are compared against the live database, so stop the workers first:
# a running pipeline changes counts during the comparison.
set -Eeuo pipefail

LOCAL_PATH="${CAREEROS_BACKUP_DIR:-$HOME/CareerOS-Backups}"
LIVE="${CAREEROS_PG_CONTAINER:-careeros-postgres-1}"
SCRATCH=careeros-restore-check
DUMP_FILE="${1:-}"

step() { echo "[verify] $*"; }
fail() { echo "[verify] FAILED: $*" >&2; exit 1; }
sql() {
  local container="$1"; shift
  docker exec -i "$container" psql -U careeros -d careeros -X -v ON_ERROR_STOP=1 -t -A "$@"
}

if [[ -z "$DUMP_FILE" ]]; then
  DUMP_FILE="$(find "$LOCAL_PATH" -maxdepth 1 -name 'careeros_*.dump' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
fi
[[ -n "$DUMP_FILE" && -f "$DUMP_FILE" ]] || fail "no dump found in $LOCAL_PATH; run scripts/backup.sh first"
docker ps -a --format '{{.Names}}' | grep -qx "$SCRATCH" && fail "container $SCRATCH already exists"

# Restore into exactly the image the live database runs, by image ID. A tag such as
# pgvector/pgvector:pg17 can move to a newer build than the live container's, and the
# restore would then test a different server than the one it is meant to vouch for.
IMAGE="$(docker inspect -f '{{.Image}}' "$LIVE" 2>/dev/null || true)"
[[ -n "$IMAGE" ]] || fail "cannot read the image of $LIVE"

trap 'docker rm -f "$SCRATCH" >/dev/null 2>&1 || true; echo "[verify] scratch container removed"' EXIT

step "restoring ${DUMP_FILE##*/} into a throwaway container"
docker run -d --rm --name "$SCRATCH" --network none --pull never \
  -e POSTGRES_USER=careeros -e POSTGRES_DB=careeros -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$DUMP_FILE:/tmp/restore.dump:ro" "$IMAGE" >/dev/null

# The image's init phase serves the Unix socket only, so a TCP check means the
# final server is up rather than the temporary one used during initialisation.
deadline=$(( SECONDS + 120 ))
until docker exec "$SCRATCH" pg_isready -h 127.0.0.1 -U careeros -d careeros >/dev/null 2>&1; do
  (( SECONDS < deadline )) || fail "scratch postgres did not start"
  sleep 2
done

# Any non-zero exit fails the check: pg_restore exits non-zero when it had to skip something
# ("errors ignored on restore"), so a restore that lost an object can never pass. Output with
# exit status 0 is reported as warnings and does not fail the check.
rc=0
restore_log="$(docker exec "$SCRATCH" pg_restore -U careeros -d careeros --no-owner --no-acl /tmp/restore.dump 2>&1)" || rc=$?
if (( rc != 0 )); then
  head -10 <<<"$restore_log" >&2
  fail "pg_restore exited with status $rc"
fi
warnings="$(grep -c . <<<"$restore_log" || true)"
step "pg_restore finished: exit status 0, $warnings warning lines"
if (( warnings > 0 )); then head -10 <<<"$restore_log" | sed 's/^/[verify]   warning: /'; fi

# Same PostgreSQL and pgvector versions as live, or the restore says nothing about the live server.
ver_sql="SELECT current_setting('server_version') || ' / pgvector ' || coalesce((SELECT extversion FROM pg_extension WHERE extname = 'vector'), 'none')"
live_ver="$(sql "$LIVE" -c "$ver_sql")"
restored_ver="$(sql "$SCRATCH" -c "$ver_sql")"
[[ "$live_ver" == "$restored_ver" ]] || fail "version mismatch: live runs $live_ver, the restore runs $restored_ver"
step "image ${IMAGE:7:12}, the one $LIVE runs; PostgreSQL $restored_ver, the same as live"

tables="$(sql "$LIVE" -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")"
count_sql=""
while read -r t; do
  count_sql+="SELECT '$t' AS t, count(*) AS n FROM \"$t\" UNION ALL "
done <<<"$tables"
count_sql="${count_sql% UNION ALL } ORDER BY 1"

live_counts="$(sql "$LIVE" -c "$count_sql")"
restored_counts="$(sql "$SCRATCH" -c "$count_sql")"
checked="$(wc -l <<<"$live_counts")"
total="$(awk -F'|' '{s+=$2} END {print s}' <<<"$restored_counts")"
if ! diff <(cat <<<"$live_counts") <(cat <<<"$restored_counts") >&2; then
  fail "row counts differ between live and restored (lines above: < live, > restored)"
fi
step "compared $checked tables, $total rows: all match"

vectors="$(sql "$SCRATCH" -c 'SELECT count(*) FROM job_embeddings WHERE vector IS NOT NULL')"
distance="$(sql "$SCRATCH" -c 'SELECT round((a.vector <=> b.vector)::numeric, 4) FROM job_embeddings a CROSS JOIN resume_embeddings b LIMIT 1')"
[[ -n "$distance" ]] || fail "pgvector could not compute a distance"
step "pgvector usable: $vectors embeddings readable, sample distance $distance"

profiles="$(sql "$SCRATCH" -c 'SELECT count(*) FROM resume_versions WHERE "confirmedProfile" IS NOT NULL')"
step "confirmedProfile rows restored: $profiles"
(( profiles >= 1 )) || step "WARNING: no confirmedProfile restored; check this is expected"

step "RESTORE VERIFIED: $checked tables match, pgvector usable"
