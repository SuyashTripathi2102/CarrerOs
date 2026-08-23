<#
.SYNOPSIS
  Collects one Phase 0 baseline row per day. Read-only over production.

.DESCRIPTION
  The >=5-day daily-cycle baseline is Phase 0's last gate. It needs five days
  that can be COMPARED, and comparison needs the numbers stored -- the previous
  attempt used a script that printed to stdout, so nothing accumulated and there
  was no baseline to review.

  This runs scripts/phase0-baseline.sql, which upserts one row keyed on the
  calendar date. Running twice in a day overwrites that day rather than
  inventing a sixth one.

  It writes to exactly one operational table and touches nothing in ingestion,
  matching, judging or scoring. If Postgres is unreachable it records the
  failure and exits non-zero rather than reporting success -- the watchdog's
  false-green on 2026-08-23 is the reason that is spelled out here.
#>
param([string]$RepoRoot = 'D:\CarrerOs')

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:TEMP 'careeros'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'phase0-baseline.log'

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding UTF8
}

$sqlFile = Join-Path $RepoRoot 'scripts\phase0-baseline.sql'
if (-not (Test-Path $sqlFile)) { Log "ERROR missing $sqlFile"; exit 1 }

try {
  # No 2>&1. In PowerShell 5.1 redirecting a native command's stderr wraps each
  # line in a NativeCommandError and reports failure even on exit 0 -- and psql
  # writes a harmless NOTICE here every run ("relation already exists,
  # skipping") from CREATE TABLE IF NOT EXISTS. ON_ERROR_STOP=1 means a real
  # SQL error still shows up in the exit code, which is what is checked.
  # ErrorActionPreference='Stop' turns ANY stderr from a native command into a
  # terminating NativeCommandError in PowerShell 5.1, and psql writes a harmless
  # NOTICE here every run ("relation already exists, skipping") from CREATE
  # TABLE IF NOT EXISTS. Relaxed just around the call; the exit code is checked
  # explicitly instead, and ON_ERROR_STOP=1 makes a real SQL error non-zero.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = Get-Content -Raw $sqlFile | docker exec -i careeros-postgres-1 `
           psql -U careeros -d careeros -v ON_ERROR_STOP=1 -f -
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) {
    Log "ERROR psql exited $code - $($out | Select-Object -Last 1)"
    exit 1
  }
  # The collected row, not just "it ran" -- a log line saying success while the
  # row is missing is the failure mode this whole exercise exists to prevent.
  $row = ($out | Select-String -Pattern '^\s*\d{4}-\d{2}-\d{2}\s*\|' | Select-Object -Last 1)
  if (-not $row) { Log 'ERROR ran but no baseline row returned'; exit 1 }
  Log "collected: $($row.ToString().Trim())"
  exit 0
} catch {
  Log "ERROR $($_.Exception.Message)"
  exit 1
}
