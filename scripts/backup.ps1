<#
.SYNOPSIS
  GATE 0 - CareerOS durability. Dumps Postgres, verifies the dump, copies it
  off-machine, and rotates old copies.

.DESCRIPTION
  Why this exists: on 2026-08-15 CareerOS had NO backups of any kind. The whole
  corpus - jobs, deep evaluations, the resume and confirmedProfile, company
  intelligence, and every future outcome event - lived in a single Docker volume
  on a single laptop. Production data had already been destroyed once that month
  (droplet wiped ~Aug 4-5) with the backups written to the same disk.

  A scraper can be rebuilt. A record of which recommendations actually produced
  interviews cannot: it is a log of real events in time. That is the moat, and
  this script is what stands between it and a dead disk.

  Two destinations, deliberately:
    LOCAL  D:\CareerOS-Backups - a different PHYSICAL drive from the Docker
           volume (Docker Desktop keeps its WSL2 vhdx under C:), so one disk
           failure does not take both.
    OFF    OneDrive - leaves the machine entirely. Survives theft, fire and a
           dead laptop, which the local copy does not.

  IMPLEMENTATION NOTE: pg_dump runs INSIDE the container writing to a file,
  which is then pulled out with `docker cp`. Piping a custom-format dump through
  a PowerShell pipeline corrupts it - PowerShell reinterprets the byte stream as
  text. That mistake produces a backup that looks fine and cannot be restored.

  A backup that has never been restored is an assumption, not a backup. Prove it
  with scripts/verify-restore.ps1.

.PARAMETER OffMachinePath
  Off-machine destination. Defaults to OneDrive when present. Pass an external
  drive or synced folder to override, or 'none' to skip (NOT gate-passing).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/backup.ps1
  powershell -ExecutionPolicy Bypass -File scripts/backup.ps1 -OffMachinePath 'E:\Backups'
#>
param(
  [string]$LocalPath = 'D:\CareerOS-Backups',
  [string]$OffMachinePath = '',
  [int]$KeepDaily = 7,
  [int]$KeepWeekly = 4,
  [string]$Container = 'careeros-postgres-1',
  [string]$DbUser = 'careeros',
  [string]$DbName = 'careeros',
  # Cold boot / wake-from-sleep: Docker Desktop needs a few minutes before the
  # engine accepts connections. Wait rather than fail.
  #
  # Raised 600 -> 1800 on 2026-08-23. At 600 the scheduled run FAILED on
  # 2026-08-20 and 2026-08-22: the task fires with StartWhenAvailable, so on a
  # machine that was asleep at 02:00 it runs on wake (08-22 fired at 03:28),
  # Docker Desktop was still starting, and the script threw. Exactly the
  # scenario the comment below predicted.
  [int]$WaitForDockerSeconds = 1800,
  # Loud if the newest dump is older than this. A backup that silently stops is
  # indistinguishable from one that is working — which is how two days of the
  # corpus went unprotected without anyone noticing.
  [int]$StaleAfterHours = 36
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'

if (-not $OffMachinePath) {
  $OffMachinePath = if ($env:OneDrive) { Join-Path $env:OneDrive 'CareerOS-Backups' } else { 'none' }
}

# Every run leaves a trace, success or failure. Until 2026-08-23 this script
# logged NOTHING: a failed scheduled run vanished, leaving only a task exit code
# nobody reads, so two missed days looked identical to two successful ones.
if (-not (Test-Path $LocalPath)) { New-Item -ItemType Directory -Path $LocalPath -Force | Out-Null }
$LogFile = Join-Path $LocalPath 'backup.log'
function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LogFile -Value $line -Encoding utf8
}
function Write-Step($msg) { Write-Host "[backup] $msg"; Write-Log $msg }

Write-Log "=== run start (pid $PID) ==="

# Report staleness BEFORE attempting anything, so even a run that then fails
# records how long the corpus has been unprotected.
$newest = Get-ChildItem -Path $LocalPath -Filter '*.dump' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest) {
  $ageH = [math]::Round(((Get-Date) - $newest.LastWriteTime).TotalHours, 1)
  if ($ageH -gt $StaleAfterHours) {
    Write-Warning "[backup] STALE: newest dump is $ageH h old ($($newest.Name)) - previous runs did not complete."
    Write-Log "STALE newest=$($newest.Name) ageHours=$ageH"
  } else {
    Write-Log "newest=$($newest.Name) ageHours=$ageH"
  }
} else {
  Write-Warning '[backup] NO PRIOR DUMP EXISTS.'
  Write-Log 'NO PRIOR DUMP'
}

# A throw anywhere below must still land in the log, or the next silent failure
# is as invisible as the last two.
trap {
  Write-Log "FAILED: $($_.Exception.Message)"
  break
}

# --- 1. Preconditions ------------------------------------------------------
# WAIT for Docker rather than failing. This task runs at 02:00 and with
# StartWhenAvailable it also fires shortly after a cold boot or a wake from
# sleep - exactly when Docker Desktop is still starting. Throwing there would
# make the backup fail on precisely the mornings it is most needed, and Gate 0
# would sit silently red.
$deadline = (Get-Date).AddSeconds($WaitForDockerSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
  $running = docker ps --filter "name=$Container" --format '{{.Names}}' 2>$null
  if ($running -eq $Container) {
    docker exec $Container pg_isready -U $DbUser 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  }
  Write-Step 'waiting for postgres to accept connections...'
  Start-Sleep -Seconds 15
}
if (-not $ready) {
  throw "Postgres '$Container' not ready after $WaitForDockerSeconds s - no backup taken."
}
New-Item -ItemType Directory -Force -Path $LocalPath | Out-Null

# --- 2. Dump inside the container, then copy out ----------------------------
$dumpName = "careeros_$stamp.dump"
$inner = "/tmp/$dumpName"
$dumpPath = Join-Path $LocalPath $dumpName
Write-Step "dumping $DbName"

docker exec $Container pg_dump -U $DbUser -d $DbName -Fc --no-owner --no-acl -f $inner
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

docker cp "${Container}:$inner" $dumpPath
if ($LASTEXITCODE -ne 0) { throw "docker cp failed with exit code $LASTEXITCODE" }
docker exec $Container rm -f $inner | Out-Null

$sizeMb = [math]::Round((Get-Item $dumpPath).Length / 1MB, 2)
if ($sizeMb -lt 0.05) { throw "dump is only $sizeMb MB - refusing to treat that as a backup" }
Write-Step "wrote $dumpName ($sizeMb MB)"

# --- 3. Integrity check -----------------------------------------------------
# Reading the archive table of contents proves it is not truncated. Cheap; the
# real proof is verify-restore.ps1.
docker cp $dumpPath "${Container}:$inner" | Out-Null
$toc = docker exec $Container pg_restore --list $inner
$tocOk = ($LASTEXITCODE -eq 0)
docker exec $Container rm -f $inner | Out-Null
if (-not $tocOk -or -not $toc) { throw "dump failed its table-of-contents check - archive is corrupt" }
Write-Step "integrity check passed ($(($toc | Measure-Object -Line).Lines) archive entries)"

# --- 4. Irreplaceable smalls, exported separately ---------------------------
# The resume and confirmed profile are tiny and cannot be re-derived from any
# source. Plain JSON so they are readable without a running Postgres.
$profileName = "profile_$stamp.json"
$profilePath = Join-Path $LocalPath $profileName
$profileSql = @'
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
'@
$profileSql | docker exec -i $Container psql -U $DbUser -d $DbName -t -A |
  Set-Content -Path $profilePath -Encoding UTF8
if ((Get-Item $profilePath).Length -lt 50) { throw "profile export looks empty - refusing" }
Write-Step "exported profile -> $profileName"

# --- 5. Off-machine copy ----------------------------------------------------
# The local copy survives a disk failure. Only this survives losing the laptop,
# which is the failure that already happened once.
if ($OffMachinePath -eq 'none') {
  Write-Warning '[backup] NO OFF-MACHINE COPY - Gate 0 is NOT satisfied by a local-only backup.'
} else {
  New-Item -ItemType Directory -Force -Path $OffMachinePath | Out-Null
  Copy-Item $dumpPath -Destination $OffMachinePath -Force
  Copy-Item $profilePath -Destination $OffMachinePath -Force
  $offCopy = Join-Path $OffMachinePath $dumpName
  if ((Get-Item $offCopy).Length -ne (Get-Item $dumpPath).Length) {
    throw "off-machine copy size mismatch - copy did not complete"
  }
  Write-Step "off-machine copy verified -> $OffMachinePath"
}

# --- 6. Rotation ------------------------------------------------------------
# Every dump from the last $KeepDaily days, plus one per week for $KeepWeekly
# weeks. Weeklies exist because corruption is sometimes discovered late.
function Invoke-Rotation([string]$dir) {
  if (-not (Test-Path $dir)) { return }
  $all = @(Get-ChildItem $dir -Filter 'careeros_*.dump' | Sort-Object LastWriteTime -Descending)
  if ($all.Count -eq 0) { return }
  $keep = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($f in $all) {
    if ($f.LastWriteTime -gt (Get-Date).AddDays(-$KeepDaily)) { [void]$keep.Add($f.FullName) }
  }
  $weeks = $all | Group-Object { (Get-Date $_.LastWriteTime).ToString('yyyy-ww') } |
    Select-Object -First $KeepWeekly
  foreach ($w in $weeks) {
    $newest = @($w.Group | Sort-Object LastWriteTime -Descending)[0]
    [void]$keep.Add($newest.FullName)
  }
  foreach ($f in $all) {
    if (-not $keep.Contains($f.FullName)) {
      Remove-Item $f.FullName -Force
      $p = $f.FullName -replace 'careeros_(.*)\.dump$', 'profile_$1.json'
      if (Test-Path $p) { Remove-Item $p -Force }
      Write-Step "rotated out $($f.Name)"
    }
  }
}
Invoke-Rotation $LocalPath
if ($OffMachinePath -ne 'none') { Invoke-Rotation $OffMachinePath }

Write-Step "DONE  local=$LocalPath  off=$OffMachinePath"
Write-Step "Restore is NOT proven by this run - use scripts/verify-restore.ps1"
