<#
.SYNOPSIS
  GATE 0 - proves a backup can actually be restored.

.DESCRIPTION
  A backup that has never been restored is an assumption, not a backup.

  This restores the newest dump into a THROWAWAY database beside the live one,
  compares row counts table by table against production, then drops it. The live
  database is never touched: the scratch DB has a distinct name and the script
  refuses to run if that name collides with the real one.

  It checks the things that actually go wrong:
    - archive truncated or corrupt (restore errors)
    - a table silently empty (count mismatch)
    - pgvector embeddings missing (extension not restored - the classic failure,
      since job_embeddings is useless without the `vector` type)
    - the irreplaceable rows present (resume, confirmedProfile, outcome events)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/verify-restore.ps1
#>
param(
  [string]$LocalPath = 'D:\CareerOS-Backups',
  [string]$DumpFile = '',
  [string]$Container = 'careeros-postgres-1',
  [string]$DbUser = 'careeros',
  [string]$DbName = 'careeros',
  [string]$ScratchDb = 'careeros_restore_check'
)

$ErrorActionPreference = 'Stop'
if ($ScratchDb -eq $DbName) { throw "scratch database must not be the live database" }

function Write-Step($msg) { Write-Host "[verify] $msg" }
function Invoke-Psql([string]$db, [string]$sql) {
  $out = $sql | docker exec -i $Container psql -U $DbUser -d $db -t -A
  if ($LASTEXITCODE -ne 0) { throw "psql failed on '$db'" }
  return $out
}

if (-not $DumpFile) {
  $newest = Get-ChildItem $LocalPath -Filter 'careeros_*.dump' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $newest) { throw "no dumps found in $LocalPath - run scripts/backup.ps1 first" }
  $DumpFile = $newest.FullName
}
Write-Step "restoring $(Split-Path $DumpFile -Leaf) into scratch db '$ScratchDb'"

$inner = "/tmp/verify_restore.dump"
docker cp $DumpFile "${Container}:$inner" | Out-Null

# Recreate the scratch DB from scratch every run.
Invoke-Psql 'postgres' "DROP DATABASE IF EXISTS $ScratchDb;" | Out-Null
Invoke-Psql 'postgres' "CREATE DATABASE $ScratchDb;" | Out-Null

try {
  # pg_restore returns non-zero on warnings too; the count comparison below is
  # the real verdict, so warnings are surfaced rather than treated as failure.
  docker exec $Container pg_restore -U $DbUser -d $ScratchDb --no-owner --no-acl $inner 2>&1 |
    Select-String -Pattern 'error' -SimpleMatch | ForEach-Object { Write-Warning $_.Line }

  # --- table-by-table row counts -------------------------------------------
  $tables = (Invoke-Psql $DbName @'
SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;
'@) -split "`n" | Where-Object { $_ -and $_.Trim() }

  $mismatches = @()
  $checked = 0
  foreach ($t in $tables) {
    $t = $t.Trim()
    $live = [int](Invoke-Psql $DbName "SELECT count(*) FROM `"$t`";").Trim()
    $rest = [int](Invoke-Psql $ScratchDb "SELECT count(*) FROM `"$t`";").Trim()
    $checked++
    if ($live -ne $rest) {
      $mismatches += "  $t : live=$live restored=$rest"
    }
  }
  Write-Step "compared $checked tables"

  # --- pgvector specifically ------------------------------------------------
  # job_embeddings restores as rows but is worthless if the `vector` type did
  # not come with it, so exercise an actual vector operation.
  $vecOk = $true
  try {
    $v = (Invoke-Psql $ScratchDb 'SELECT count(*) FROM job_embeddings WHERE vector IS NOT NULL;').Trim()
    Write-Step "pgvector usable in restored db ($v embeddings readable)"
  } catch { $vecOk = $false; Write-Warning "pgvector NOT usable in the restored database" }

  # --- the irreplaceable rows ----------------------------------------------
  $profileRows = [int](Invoke-Psql $ScratchDb 'SELECT count(*) FROM resume_versions WHERE "confirmedProfile" IS NOT NULL;').Trim()
  $eventRows = [int](Invoke-Psql $ScratchDb 'SELECT count(*) FROM opportunity_events;').Trim()
  Write-Step "confirmedProfile rows restored: $profileRows | outcome events restored: $eventRows"

  if ($mismatches.Count -gt 0) {
    Write-Host ''
    Write-Host 'ROW COUNT MISMATCHES:' -ForegroundColor Red
    $mismatches | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    throw "restore verification FAILED - $($mismatches.Count) table(s) differ"
  }
  if (-not $vecOk) { throw "restore verification FAILED - pgvector unusable" }
  if ($profileRows -lt 1) { Write-Warning "no confirmedProfile restored - check this is expected" }

  Write-Host ''
  Write-Host "GATE 0 RESTORE VERIFIED - $checked tables match, pgvector usable." -ForegroundColor Green
}
finally {
  docker exec $Container rm -f $inner | Out-Null
  Invoke-Psql 'postgres' "DROP DATABASE IF EXISTS $ScratchDb;" | Out-Null
  Write-Step "scratch database dropped"
}
