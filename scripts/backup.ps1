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
  [string]$DbName = 'careeros'
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'

if (-not $OffMachinePath) {
  $OffMachinePath = if ($env:OneDrive) { Join-Path $env:OneDrive 'CareerOS-Backups' } else { 'none' }
}

function Write-Step($msg) { Write-Host "[backup] $msg" }

# --- 1. Preconditions ------------------------------------------------------
$running = docker ps --filter "name=$Container" --format '{{.Names}}'
if ($running -ne $Container) {
  throw "Postgres container '$Container' is not running - nothing to back up. Start the stack first."
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
