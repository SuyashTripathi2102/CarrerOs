<#
.SYNOPSIS
  Idempotent watchdog: makes sure the whole CareerOS stack is running.
  Safe to run every 10 minutes, forever. Starts only what is missing.

.DESCRIPTION
  CareerOS is an always-on pipeline: discovery ticks every 10-15 minutes and the
  evaluation conveyor belt every 15. Anything that silently stops the stack
  stops opportunity flow, and the failure is invisible - /today simply goes
  quiet, which looks exactly like "no good jobs today".

  Three real failure modes this covers, all observed:

    REBOOT      Docker Desktop and the containers come back on their own
                (restart: unless-stopped + a Run-key entry), but the API and
                workers were started by hand and do NOT. The belt stays off.
    SLEEP/WAKE  Node processes survive suspend but can wake holding dead TCP
                connections to Redis/Postgres. A worker in that state looks
                alive to Task Manager and processes nothing.
    SILENT DEATH  Docker Desktop stopped by itself on 2026-08-14, mid-session,
                with no prompt. The API also died when Prisma regenerated its
                client underneath a running `nest start --watch`.

  Everything here is a no-op when the component is already healthy, so this is
  a watchdog rather than a restarter: it never bounces a working process.

.PARAMETER Restart
  Force-restart the API and workers even if they look alive. Use after a code
  change, or when a process is suspected to be wedged on stale connections.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/ensure-stack.ps1
  powershell -ExecutionPolicy Bypass -File scripts/ensure-stack.ps1 -Restart
#>
param(
  [string]$RepoRoot = 'D:\CarrerOs',
  [switch]$Restart,
  [int]$DockerWaitSeconds = 180,
  [int]$ApiWaitSeconds = 180
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:TEMP 'careeros'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$watchdogLog = Join-Path $logDir 'watchdog.log'

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Host $line
  Add-Content -Path $watchdogLog -Value $line -Encoding UTF8
}

function Test-Api {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3001/api/health' -UseBasicParsing -TimeoutSec 5
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Get-NodeProcs([string]$match) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like $match }
}

<#
  Process signatures, matched against the ACTUAL command lines.

  Two bugs live here as comments because both produced a watchdog that was
  worse than none:

  1. Matching workers on '*workers*' found NOTHING - the process runs as
     `node .../tsx/dist/cli.mjs watch src/index.ts`, with 'apps\workers' only
     in its working directory, which Win32_Process does not expose. The
     watchdog concluded the workers were down on every tick and started
     another, spawning a duplicate every 10 minutes, each consuming the same
     BullMQ queues and doubling LLM spend.

  2. Widening it to '*src/index.ts*' then matched several processes of the
     SAME instance.

  Each of these matches the LEADER of its process tree, exactly once per
  running instance. `npm run dev` produces npm-cli -> tsx/cli.mjs -> a child
  node holding tsx's preflight, and a broader pattern like '*src/index.ts*'
  matches several of them. An earlier version did exactly that, decided a
  single healthy worker was "3 duplicates", killed the tsx CHILD, and left an
  orphaned parent watching a dead app - the workers stopped consuming while
  still looking alive. Match the leader, and kill the TREE.
#>
$API_PROC = '*nest.js*start*'
$WORKER_PROC = '*tsx*cli.mjs*watch*'

<# Kill a process and everything it spawned. Stop-Process orphans children,
   which is how a half-killed worker ends up wedged. #>
function Stop-Tree([int]$processId) {
  & taskkill.exe /PID $processId /T /F 2>&1 | Out-Null
}

<# Keep exactly one instance; kill the rest. Self-heals duplicates left behind
   by an earlier bad tick or a half-finished restart. #>
function Remove-DuplicateProcs([string]$match, [string]$label) {
  $procs = @(Get-NodeProcs $match | Sort-Object CreationDate)
  if ($procs.Count -le 1) { return $procs }
  Log "found $($procs.Count) $label instances - killing $($procs.Count - 1) duplicate(s)"
  foreach ($p in $procs[1..($procs.Count - 1)]) { Stop-Tree $p.ProcessId }
  return @($procs[0])
}

function Start-Detached([string]$cmd, [string]$workdir, [string]$logFile) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "$cmd > `"$logFile`" 2>&1" `
    -WorkingDirectory $workdir -WindowStyle Hidden
}

# --- 1. Docker Desktop ------------------------------------------------------
if (-not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) {
  Log 'docker desktop not running - starting'
  $exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  if (Test-Path $exe) { Start-Process $exe } else { Log "WARN docker desktop not found at $exe" }
}

# Wait for the ENGINE, not the process: the tray app is up long before the
# daemon accepts connections, and starting containers too early just fails.
$deadline = (Get-Date).AddSeconds($DockerWaitSeconds)
$engineUp = $false
while ((Get-Date) -lt $deadline) {
  docker ps 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $engineUp = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $engineUp) { Log 'ERROR docker engine did not come up - aborting'; exit 1 }

# --- 2. Containers ----------------------------------------------------------
# restart:unless-stopped covers reboots, but not a `docker compose down` or a
# container that exited badly. `up -d` is a no-op when they are already healthy.
$names = (docker ps --format '{{.Names}}') -join ' '
if ($names -notmatch 'careeros-postgres-1' -or $names -notmatch 'careeros-redis-1') {
  Log 'containers missing - docker compose up -d'
  Push-Location $RepoRoot
  try { docker compose up -d 2>&1 | Out-Null } finally { Pop-Location }
  Start-Sleep -Seconds 5
}

# Postgres accepting connections is the real readiness signal.
$deadline = (Get-Date).AddSeconds(120)
$pgUp = $false
while ((Get-Date) -lt $deadline) {
  docker exec careeros-postgres-1 pg_isready -U careeros 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $pgUp = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $pgUp) { Log 'ERROR postgres not accepting connections - aborting'; exit 1 }

# --- 3. API -----------------------------------------------------------------
Remove-DuplicateProcs $API_PROC 'api' | Out-Null
$apiHealthy = Test-Api
if ($Restart -and $apiHealthy) {
  Log 'restart requested - stopping api'
  Get-NodeProcs $API_PROC | ForEach-Object { Stop-Tree $_.ProcessId }
  Start-Sleep -Seconds 3
  $apiHealthy = $false
}
if (-not $apiHealthy) {
  # A process may exist while the port is dead (wedged on stale connections
  # after wake). Clear it first or the new instance hits EADDRINUSE.
  $stale = @(Get-NodeProcs $API_PROC)
  if ($stale.Count -gt 0) {
    Log "api process alive but not healthy - clearing $($stale.Count) instance(s)"
    $stale | ForEach-Object { Stop-Tree $_.ProcessId }
    Start-Sleep -Seconds 3
  }
  Log 'starting api'
  Start-Detached 'npx nest start' (Join-Path $RepoRoot 'apps\api') (Join-Path $logDir 'api.log')

  $deadline = (Get-Date).AddSeconds($ApiWaitSeconds)
  while ((Get-Date) -lt $deadline -and -not (Test-Api)) { Start-Sleep -Seconds 5 }
  if (Test-Api) { Log 'api healthy' } else { Log 'ERROR api did not become healthy' }
} else {
  Log 'api healthy (no action)'
}

# --- 4. Workers -------------------------------------------------------------
# No health endpoint, so presence is the signal. The belt is what actually
# matters here: without workers nothing is discovered and nothing is judged.
$workerProcs = Remove-DuplicateProcs $WORKER_PROC 'worker'
if ($Restart -and $workerProcs.Count -gt 0) {
  Log 'restart requested - stopping workers'
  $workerProcs | ForEach-Object { Stop-Tree $_.ProcessId }
  Start-Sleep -Seconds 3
  $workerProcs = @()
}
if ($workerProcs.Count -eq 0) {
  Log 'starting workers'
  Start-Detached 'npm run dev' (Join-Path $RepoRoot 'apps\workers') (Join-Path $logDir 'workers.log')
  Start-Sleep -Seconds 15
  if (@(Get-NodeProcs $WORKER_PROC).Count -gt 0) { Log 'workers up' }
  else { Log 'ERROR workers did not start' }
} else {
  Log 'workers running (no action)'
}

Log 'stack OK'
