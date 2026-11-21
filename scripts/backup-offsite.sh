#!/usr/bin/env bash
# Copies the newest local backup, the dump AND its profile, to ANOTHER device
# (USB drive, SD card, external disk) and proves both copies are byte-identical.
#
#   scripts/backup-offsite.sh /media/$USER/<drive>
#
# Refuses a destination on the laptop's own disk, or in memory (tmpfs): a copy
# that dies with the laptop is not a second copy. Refuses a dump whose profile
# is missing: the profile holds the resumes and the confirmed profile, the rows
# that cannot be re-derived, so a dump alone is not a complete backup.
#
# Both checksums are added to CHECKSUMS.txt in sha256sum format, so the copy
# can be re-checked on any machine with:
#   cd /media/$USER/<drive>/CareerOS-Backups && sha256sum -c CHECKSUMS.txt
#
# A run either ends with both files on the device AND recorded in CHECKSUMS.txt,
# or leaves the device as it found it. It never overwrites or removes a file
# that was already there: temporary files get new random names and are created
# exclusively, and final names are given by a rename that cannot replace
# anything. Both need python3 (standard on Ubuntu), and the rename needs a
# filesystem that supports it; without them the copy fails and nothing from the
# run is kept.
#
# Run one copy to a drive at a time. An existing CHECKSUMS.txt is replaced by a
# new version that contains it unchanged, so a line another program wrote into
# it during the run would be lost.
#
# For a full restore test of the copy afterwards (stop the workers first, as
# that script explains):
#   scripts/verify-restore.sh /media/$USER/<drive>/CareerOS-Backups/<dump>
set -euo pipefail

SRC="${CAREEROS_BACKUP_DIR:-$HOME/CareerOS-Backups}"
# What this run has created. All of it is removed on any exit until
# CHECKSUMS.txt records the copy; nothing else is ever removed.
STAGED=()     # temporary files on the device, each recorded once created
CREATED=()    # final names, each recorded once its rename has succeeded
NEW_DIR=""    # the CareerOS-Backups folder, if this run created it
LOCAL_LIST="" # the new CHECKSUMS.txt, built on the laptop (always removed)

fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  if ((${#CREATED[@]} + ${#STAGED[@]})); then rm -f -- "${CREATED[@]}" "${STAGED[@]}"; fi
  if [[ -n "$NEW_DIR" ]]; then rmdir -- "$NEW_DIR" 2>/dev/null || true; fi
  if [[ -n "$LOCAL_LIST" ]]; then rm -f -- "$LOCAL_LIST"; fi
}
exists() { [[ -e "$1" || -L "$1" ]]; }

# Read back from the device itself where the filesystem allows it, so the
# checksum is not satisfied by the page cache that the copy just filled.
device_sha256() {
  dd if="$1" iflag=direct bs=4M status=none 2>/dev/null | sha256sum | cut -d' ' -f1 \
    || sha256sum "$1" | cut -d' ' -f1
}

# Prints the sha256 of <file> if <copy>, read back from the device, matches it.
# It returns 1 otherwise.
verified_sha() {
  local want got
  want="$(sha256sum "$1" | cut -d' ' -f1)"
  got="$(device_sha256 "$2")"
  [[ "$want" == "$got" ]] || return 1
  printf '%s' "$want"
}

# Prints the existing CHECKSUMS.txt unchanged, then the new lines. It returns 1
# if the existing list cannot be read or the output cannot be written.
extended_manifest() {
  local manifest="$1"
  shift
  if [[ -f "$manifest" ]]; then cat -- "$manifest" || return 1; fi
  printf '%s\n' "$@" || return 1
}

# Creates <path> and fills it from <src>. The file is created with
# O_CREAT|O_EXCL, so if anything already has that name nothing is created or
# touched. The data goes through the file just created, never by opening the
# name again, and is flushed to the device. Exit 0: created and filled. Exit 17:
# the name was taken. Exit 10: created, then filling failed (the file is this
# run's). Any other exit: nothing was created.
create_temp() {
  python3 -I -c '
import errno, os, shutil, sys
def why(e):
    return "%s (%s)" % (e.strerror, errno.errorcode.get(e.errno, e.errno))
path, src = sys.argv[1], sys.argv[2]
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    sys.exit(17)
except OSError as e:
    sys.exit(why(e))
try:
    with open(src, "rb") as f, os.fdopen(fd, "wb") as out:
        shutil.copyfileobj(f, out, 4 << 20)
        out.flush()
        st = os.fstat(f.fileno())
        os.utime(out.fileno(), ns=(st.st_atime_ns, st.st_mtime_ns))
        os.fsync(out.fileno())
except BaseException as e:
    print(why(e) if isinstance(e, OSError) else repr(e), file=sys.stderr)
    os._exit(10)
' "$1" "$2"
}

# Puts a copy of <src> in <dir> under a new random name, and sets <variable>
# to that name. A name that is already taken is left alone and another is
# tried. A file is recorded for the cleanup only once this run has created it.
stage() { # stage <variable> <dir> <final name> <src>
  local try path rc why
  for try in 1 2 3 4 5; do
    path="$2/.$3.$(printf '%08x%08x' "$SRANDOM" "$SRANDOM").partial"
    rc=0
    why="$(create_temp "$path" "$4" 2>&1)" || rc=$?
    case "$rc" in
      0) STAGED+=("$path"); printf -v "$1" '%s' "$path"; return 0 ;;
      17) ;; # taken: whatever is there is not this run's, and is not touched
      10) STAGED+=("$path"); fail "could not write $3 to the device: $why; nothing from this run is kept" ;;
      *) fail "could not create a temporary file for $3 on the device: ${why:-exit $rc}; nothing from this run is kept" ;;
    esac
  done
  fail "all $try temporary names tried for $3 were already taken; nothing from this run is kept"
}

# Renames without ever replacing: renameat2 with RENAME_NOREPLACE makes the
# kernel check the final name and rename in one step, so a file that appears
# there at any moment is never overwritten; the rename fails instead. There is
# deliberately no fallback (mv -n quietly falls back to a separate check and
# rename where the filesystem lacks this): if it fails for any reason, so does
# the copy.
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
# rename succeeds, so the cleanup removes only what this run created; a file
# someone else put there makes the rename fail and is never recorded. Signals
# are held off around these calls (see main), so nothing can stop the run
# between a rename and its record.
place() {
  local tmp="$1" final="$2" why
  why="$(rename_noreplace "$tmp" "$final" 2>&1)" \
    || fail "could not give ${final##*/} its final name: ${why:-the rename failed}. Anything already at that name is untouched; nothing from this run is kept"
  CREATED+=("$final")
}

main() {
  local dest_root="${1:-}"
  [[ -n "$dest_root" && -d "$dest_root" ]] || fail "usage: $0 <mounted folder on another device>"

  local src_source dest_source dest_type
  src_source="$(findmnt -no SOURCE -T "$SRC")"
  dest_source="$(findmnt -no SOURCE -T "$dest_root")"
  dest_type="$(findmnt -no FSTYPE -T "$dest_root")"
  case "$dest_type" in
    tmpfs | ramfs | overlay | squashfs) fail "$dest_root is $dest_type, not a durable device" ;;
  esac
  [[ "$src_source" != "$dest_source" ]] || fail "$dest_root is on the same disk as $SRC ($src_source)"

  local dump stamp profile dest manifest dump_name profile_name dump_sha profile_sha want name had_manifest="" leftovers
  local tmp_dump tmp_profile tmp_list
  local -a lines
  dump="$(find "$SRC" -maxdepth 1 -name 'careeros_*.dump' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
  [[ -n "$dump" ]] || fail "no dump in $SRC; run scripts/backup.sh first"
  stamp="${dump##*/careeros_}"
  stamp="${stamp%.dump}"
  profile="$SRC/profile_${stamp}.json"
  dump_name="${dump##*/}"
  profile_name="${profile##*/}"
  dest="$dest_root/CareerOS-Backups"
  manifest="$dest/CHECKSUMS.txt"

  # Checked before anything is written, so a refusal leaves the device untouched.
  [[ -f "$profile" ]] || fail "$profile_name is missing beside $dump_name; refusing an incomplete offsite copy"
  for name in "$dump_name" "$profile_name"; do
    if exists "$dest/$name"; then
      fail "$name is already on the device, so nothing was changed. If CHECKSUMS.txt lists it, check the copy with sha256sum -c CHECKSUMS.txt; if not, it is left from an interrupted copy and can be removed by hand before running this again"
    fi
  done

  trap cleanup EXIT
  # mkdir without -p fails if the folder exists, so NEW_DIR is set only when
  # this run created it.
  if mkdir -- "$dest" 2>/dev/null; then NEW_DIR="$dest"; fi
  [[ -d "$dest" ]] || fail "could not create $dest"
  chmod 700 "$dest" 2>/dev/null || true # FAT/exFAT drives ignore permissions

  leftovers="$(find "$dest" -maxdepth 1 -name '.*.partial' 2>/dev/null | wc -l)" || leftovers="some"
  if [[ "$leftovers" != 0 ]]; then
    echo "note: $leftovers hidden .partial file(s) were already in $dest, left by an interrupted copy or by another program. They are not touched; check them and remove them by hand."
  fi

  stage tmp_dump "$dest" "$dump_name" "$dump"
  dump_sha="$(verified_sha "$dump" "$tmp_dump")" \
    || fail "checksum mismatch for $dump_name (the copy is damaged); nothing from this run is kept"
  stage tmp_profile "$dest" "$profile_name" "$profile"
  profile_sha="$(verified_sha "$profile" "$tmp_profile")" \
    || fail "checksum mismatch for $profile_name (the copy is damaged); nothing from this run is kept"

  # The new list is the old one, byte for byte, plus two lines. It is built on
  # the laptop, then staged and read back before any final name appears, so a
  # full or failing device stops the run while the device is still unchanged.
  lines=("$dump_sha  $dump_name" "$profile_sha  $profile_name")
  if [[ -f "$manifest" ]]; then had_manifest=1; fi
  LOCAL_LIST="$(mktemp)" || fail "could not create a temporary file on the laptop; nothing from this run is kept"
  extended_manifest "$manifest" "${lines[@]}" >"$LOCAL_LIST" \
    || fail "could not read CHECKSUMS.txt; nothing from this run is kept"
  stage tmp_list "$dest" CHECKSUMS.txt "$LOCAL_LIST"
  want="$(sha256sum "$LOCAL_LIST" | cut -d' ' -f1)"
  [[ "$(device_sha256 "$tmp_list")" == "$want" ]] \
    || fail "the new CHECKSUMS.txt read back wrong; nothing from this run is kept"

  # Only three renames remain: the profile, then the dump, then the list, so a
  # final dump always has its profile beside it. A failed rename still exits,
  # and the cleanup removes the final names already given. Signals are held off
  # until the list records the copy: a stop right after the last rename would
  # otherwise make the cleanup delete files that CHECKSUMS.txt already lists.
  # The existing list is meant to be replaced (its content is in the new one);
  # where there was none, the new list never replaces one that appeared.
  trap '' INT TERM HUP
  place "$tmp_profile" "$dest/$profile_name"
  place "$tmp_dump" "$dest/$dump_name"
  if [[ -n "$had_manifest" ]]; then
    mv -- "$tmp_list" "$manifest" || fail "could not replace CHECKSUMS.txt; nothing from this run is kept"
  else
    place "$tmp_list" "$manifest"
  fi
  CREATED=()
  STAGED=()
  NEW_DIR=""
  trap - INT TERM HUP
  sync

  echo "copied and verified $dump_name ($(du -h -- "$dump" | cut -f1), sha256 ${dump_sha:0:16})"
  echo "copied and verified $profile_name ($(du -h -- "$profile" | cut -f1), sha256 ${profile_sha:0:16})"
  echo "recorded both in CHECKSUMS.txt ($(wc -l <"$manifest") lines; the earlier lines unchanged)"
  echo "OFFSITE COPY VERIFIED -> $dest ($dest_source, $dest_type)"
  echo "Keep this drive away from the laptop. The dump holds your resume and job-search data."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
