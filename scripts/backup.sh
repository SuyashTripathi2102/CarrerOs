#!/usr/bin/env bash
# Linux counterpart of backup.ps1. Dumps Postgres and the irreplaceable profile
# rows into one folder, checks the archive, and rotates old copies.
# A dump is not a proven backup until scripts/verify-restore.sh has restored it.
#
# Both files are written under new random temporary names, created
# exclusively, and get their final names only once checked, by a rename that
# cannot replace anything. So a final careeros_*.dump is always a complete,
# verified archive with its profile beside it, no existing file is ever
# overwritten, and a failed run removes only what it created itself. Apart
# from that, the only files this script deletes are old backups, by rotate().
# Needs python3 (standard on Ubuntu) and a filesystem that supports the
# no-replace rename; without them the run fails and nothing is kept.
set -Eeuo pipefail
# The last command of a pipeline runs in this shell, so stage() can record the
# files it creates while reading from docker.
shopt -s lastpipe
umask 077

LOCAL_PATH="${CAREEROS_BACKUP_DIR:-$HOME/CareerOS-Backups}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
CONTAINER="${CAREEROS_PG_CONTAINER:-careeros-postgres-1}"
DB_USER=careeros
DB_NAME=careeros
# A timer can fire right after boot or wake, before Postgres accepts connections.
WAIT_SECONDS="${WAIT_SECONDS:-1800}"
STALE_AFTER_HOURS=36

STAMP="$(date +%F_%H%M%S)"
DUMP_NAME="careeros_${STAMP}.dump"
PROFILE_NAME="profile_${STAMP}.json"
DUMP_PATH="$LOCAL_PATH/$DUMP_NAME"
PROFILE_PATH="$LOCAL_PATH/$PROFILE_NAME"
LOG_FILE="$LOCAL_PATH/backup.log"
# What this run has created. All of it is removed on any exit until both final
# names are in place; the cleanup never removes anything else.
INNER=""   # pg_dump's file inside the container, once created
STAGED=()  # temporary files in LOCAL_PATH, each recorded once created
CREATED=() # final names, each recorded once its rename has succeeded

mkdir -p "$LOCAL_PATH"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG_FILE"; }
step() { echo "[backup] $*"; log "$*"; }
fail() { echo "[backup] FAILED: $*" >&2; log "FAILED: $*"; exit 1; }

cleanup() {
  if [[ -n "$INNER" ]]; then docker exec "$CONTAINER" rm -f -- "$INNER" >/dev/null 2>&1 || true; fi
  if ((${#CREATED[@]} + ${#STAGED[@]})); then rm -f -- "${CREATED[@]}" "${STAGED[@]}"; fi
}
trap 'log "FAILED: command at line $LINENO exited $?"' ERR
trap cleanup EXIT

# Creates <path> and fills it from standard input. The file is created with
# O_CREAT|O_EXCL, so if anything already has that name nothing is created or
# touched. The data goes through the file just created, never by opening the
# name again, and is flushed to disk. Exit 0: created and filled. Exit 17: the
# name was taken (nothing has been read from standard input). Exit 10: created,
# then filling failed (the file is this run's). Any other exit: nothing was
# created.
create_temp() {
  python3 -I -c '
import errno, os, shutil, sys
def why(e):
    return "%s (%s)" % (e.strerror, errno.errorcode.get(e.errno, e.errno))
path = sys.argv[1]
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    sys.exit(17)
except OSError as e:
    sys.exit(why(e))
try:
    with os.fdopen(fd, "wb") as out:
        shutil.copyfileobj(sys.stdin.buffer, out, 4 << 20)
        out.flush()
        os.fsync(out.fileno())
except BaseException as e:
    print(why(e) if isinstance(e, OSError) else repr(e), file=sys.stderr)
    os._exit(10)
' "$1"
}

# Writes standard input to a new random name in <dir> and sets <variable> to
# that name. A name that is already taken is left alone and another is tried.
# A file is recorded for the cleanup only once this run has created it.
stage() { # stage <variable> <dir> <final name> < data
  local try path rc why
  for try in 1 2 3 4 5; do
    path="$2/.$3.$(printf '%08x%08x' "$SRANDOM" "$SRANDOM").partial"
    rc=0
    why="$(create_temp "$path" 2>&1)" || rc=$?
    case "$rc" in
      0) STAGED+=("$path"); printf -v "$1" '%s' "$path"; return 0 ;;
      17) ;; # taken: whatever is there is not this run's, and is not touched
      10) STAGED+=("$path"); fail "could not write $3 in $2: $why; nothing from this run is kept" ;;
      *) fail "could not create a temporary file for $3 in $2: ${why:-exit $rc}; nothing from this run is kept" ;;
    esac
  done
  fail "all $try temporary names tried for $3 were already taken; nothing from this run is kept"
}

# Renames without ever replacing: renameat2 with RENAME_NOREPLACE makes the
# kernel check the final name and rename in one step, so a file that appears
# there at any moment is never overwritten; the rename fails instead. There is
# deliberately no fallback: if it fails for any reason, so does the run.
rename_noreplace() {
  python3 -I -c '
import ctypes, errno, os, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
AT_FDCWD, RENAME_NOREPLACE = -100, 1
if libc.renameat2(AT_FDCWD, os.fsencode(sys.argv[1]), AT_FDCWD, os.fsencode(sys.argv[2]), RENAME_NOREPLACE) != 0:
    e = ctypes.get_errno()
    sys.exit("%s (%s)" % (os.strerror(e), errno.errorcode.get(e, e)))
' "$1" "$2"
}

# Gives a checked file its final name. The name is recorded only after the
# rename succeeds, so the cleanup removes only what this run created. Signals
# are held off around these calls (see below), so nothing can stop the run
# between a rename and its record.
place() {
  local tmp="$1" final="$2" why
  why="$(rename_noreplace "$tmp" "$final" 2>&1)" \
    || fail "could not give ${final##*/} its final name: ${why:-the rename failed}. Anything already at that name is untouched; nothing from this run is kept"
  CREATED+=("$final")
}

log "=== run start (pid $$) ==="

# Unfinished files of earlier runs (killed outright, power loss) are reported,
# never deleted: a name and an age do not prove which run, or which program,
# made a file.
leftovers="$(find "$LOCAL_PATH" -maxdepth 1 -name '.*.partial' | wc -l)" || leftovers="some"
if [[ "$leftovers" != 0 ]]; then
  step "note: $leftovers hidden .partial file(s) in $LOCAL_PATH, left by an interrupted run or another program; they are not touched. Check them and remove them by hand."
fi

newest="$(find "$LOCAL_PATH" -maxdepth 1 -name '*.dump' -printf '%T@ %p\n' | sort -rn | head -1 || true)"
if [[ -n "$newest" ]]; then
  age_hours=$(( ($(date +%s) - ${newest%%.*}) / 3600 ))
  if (( age_hours > STALE_AFTER_HOURS )); then
    step "STALE: newest dump is ${age_hours}h old (${newest##*/}); previous runs did not complete"
  else
    log "newest=${newest##*/} ageHours=$age_hours"
  fi
else
  step "no prior dump exists"
fi

deadline=$(( SECONDS + WAIT_SECONDS ))
until docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do
  (( SECONDS < deadline )) || fail "postgres not ready after ${WAIT_SECONDS}s; no backup taken"
  step "waiting for postgres to accept connections..."
  sleep 15
done

# A backup with this run's names already exists (two runs in the same second):
# refuse before dumping. The final renames would refuse it anyway.
for name in "$DUMP_NAME" "$PROFILE_NAME"; do
  if [[ -e "$LOCAL_PATH/$name" || -L "$LOCAL_PATH/$name" ]]; then fail "$name already exists in $LOCAL_PATH; nothing was changed"; fi
done

step "dumping $DB_NAME"
# mktemp creates pg_dump's file exclusively inside the container, so the
# cleanup there removes only this run's file.
INNER="$(docker exec "$CONTAINER" mktemp /tmp/careeros_backup.XXXXXXXXXX)" \
  || fail "could not create a temporary file in $CONTAINER; no backup taken"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc --no-owner --no-acl -f "$INNER"
inner_sha="$(docker exec "$CONTAINER" sha256sum "$INNER" | cut -d' ' -f1)"
docker exec "$CONTAINER" cat "$INNER" | stage tmp_dump "$LOCAL_PATH" "$DUMP_NAME" \
  || fail "could not copy the dump out of $CONTAINER; nothing from this run is kept"
docker exec "$CONTAINER" rm -f -- "$INNER" >/dev/null
INNER=""

# The archive checks below read only what they need, so they cannot see a copy
# cut short. Comparing checksums can.
[[ "$(sha256sum "$tmp_dump" | cut -d' ' -f1)" == "$inner_sha" ]] \
  || fail "the copied dump differs from the one pg_dump wrote; the copy is incomplete or damaged"
size_bytes="$(stat -c %s "$tmp_dump")"
(( size_bytes >= 51200 )) || fail "dump is only $size_bytes bytes; refusing to treat that as a backup"
step "copied the dump out ($(( size_bytes / 1048576 )) MB, sha256 ${inner_sha:0:16}, identical to pg_dump's)"

# Checks the file that was copied out, streamed back to pg_restore's standard
# input. The table of contents is only the start of the file; the second
# command reads every data block (about 12 s at 1.2 GB). pg_restore -f writes a
# script, here to /dev/null, and never connects to the database.
entries="$(docker exec -i "$CONTAINER" pg_restore --list <"$tmp_dump" | wc -l)"
(( entries > 0 )) || fail "dump failed its table-of-contents check; archive is corrupt"
docker exec -i "$CONTAINER" pg_restore -f /dev/null <"$tmp_dump" >/dev/null 2>&1 \
  || fail "dump failed a full read; the archive is damaged"
step "integrity check passed ($entries archive entries, every data block read)"

docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -X -v ON_ERROR_STOP=1 -t -A <<'SQL' | stage tmp_profile "$LOCAL_PATH" "$PROFILE_NAME" || fail "the profile export failed; nothing from this run is kept"
SELECT json_build_object(
  'exportedAt', now(),
  'users', (SELECT json_agg(row_to_json(u)) FROM (SELECT id, email, name FROM users) u),
  'resumes', (SELECT json_agg(row_to_json(r)) FROM (SELECT id, "userId", title, "isPrimary", "masterHtml" FROM resumes) r),
  'resumeVersions', (SELECT json_agg(row_to_json(v)) FROM (
      SELECT id, "resumeId", "versionNumber", "parsedJson", "confirmedProfile",
             "manuallyAddedSkills", "skillProvenance", "activatedAt"
      FROM resume_versions) v),
  'preferences', (SELECT json_agg(row_to_json(p)) FROM user_preferences p)
);
SQL
(( $(stat -c %s "$tmp_profile") >= 50 )) || fail "profile export looks empty; refusing"

# Only now do the final names appear: the profile first and the dump last, so
# anything that picks the newest dump finds its profile beside it. Neither
# rename can replace an existing file, and a failed second rename takes the
# first one back. Signals are held off until both are in place.
trap '' INT TERM HUP
place "$tmp_profile" "$PROFILE_PATH"
place "$tmp_dump" "$DUMP_PATH"
CREATED=()
STAGED=()
trap - INT TERM HUP
step "wrote $DUMP_NAME and $PROFILE_NAME"

rotate() {
  local cutoff week_count=0 mtime path week
  local -A keep=() weeks_seen=()
  cutoff=$(( $(date +%s) - KEEP_DAILY * 86400 ))

  while read -r mtime path; do
    mtime="${mtime%.*}"
    if (( mtime > cutoff )); then keep["$path"]=1; fi
    week="$(date -d "@$mtime" +%G-%V)"
    if [[ -z "${weeks_seen[$week]:-}" ]]; then
      weeks_seen["$week"]=1
      if (( week_count < KEEP_WEEKLY )); then
        keep["$path"]=1
        week_count=$(( week_count + 1 ))
      fi
    fi
  done < <(find "$LOCAL_PATH" -maxdepth 1 -name 'careeros_*.dump' -printf '%T@ %p\n' | sort -rn)

  while read -r mtime path; do
    if [[ -z "${keep[$path]:-}" ]]; then
      rm -f -- "$path"
      local stamp_part="${path##*/careeros_}"
      rm -f -- "$LOCAL_PATH/profile_${stamp_part%.dump}.json"
      step "rotated out ${path##*/}"
    fi
  done < <(find "$LOCAL_PATH" -maxdepth 1 -name 'careeros_*.dump' -printf '%T@ %p\n')
}
rotate

step "local copy only: a dead disk or lost laptop would take this backup with it"
step "DONE local=$LOCAL_PATH"
