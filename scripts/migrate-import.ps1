<#
.SYNOPSIS
  Rebuilds CareerOS on a new laptop from a migrate-export.ps1 bundle.

.DESCRIPTION
  Checks every file against the manifest, clones the repo, restores local files,
  installs dependencies, restores Postgres and MinIO, then proves the restore by
  comparing every table to the counts taken on the old laptop.

  Safe to re-run. It never overwrites a database that already has tables, and it
  keeps any existing file that differs from the bundle unless -Force is passed.

  Order matters: the dump is restored into an EMPTY database and migrations run
  afterwards. Migrating first creates the tables and pg_restore then collides
  with every one of them.

  Pinned npm is not optional. npm 11.16 silently skips the Prisma, bcrypt and
  sharp postinstalls, which produces a broken Prisma client.

.PARAMETER Rehearsal
  Test run on a machine that already has CareerOS: registers the scheduled tasks
  disabled, with a -Rehearsal suffix. Pair with -UserHome so Claude's files land
  somewhere disposable.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\migrate-import.ps1 -RepoRoot D:\CarrerOs
#>
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [string]$Bundle = '',
  [string]$ComposeProject = 'careeros',
  [string]$UserHome = $env:USERPROFILE,
  [switch]$Force,
  [switch]$Rehearsal
)

# Resolved here, not as the parameter default: Windows PowerShell 5.1 leaves
# $PSScriptRoot empty while binding parameters under -File.
if (-not $Bundle) { $Bundle = $PSScriptRoot }

$ErrorActionPreference = 'Stop'
$NpmPin = 'npm@11.12.1'
$pg = "$ComposeProject-postgres-1"
$minio = "$ComposeProject-minio-1"

function Write-Step($msg) { Write-Host "[import] $msg" }

# PowerShell 5.1 can turn a native command's stderr into a terminating error, and
# docker, npm and pip all write progress there. The exit code is the real verdict.
function Invoke-Native([string]$label, [scriptblock]$cmd) {
  Write-Step $label
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 0
  try { & $cmd | Out-Host; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  if ($code -ne 0) { throw "$label failed with exit code $code" }
}

function Invoke-Psql([string]$sql) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = $sql | docker exec -i $pg psql -U careeros -d careeros -t -A; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
  if ($code -ne 0) { throw "psql failed: $sql" }
  return $out
}

function Find-Python312 {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $exe = & py -3.12 -c 'import sys; print(sys.executable)' 2>$null
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -eq 0 -and $exe) { return "$exe".Trim() }
  }
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:ProgramFiles\Python312\python.exe"
  ) + @(Get-ChildItem "$env:APPDATA\uv\python\cpython-3.12*\python.exe" -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName })
  return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

# --- 1. Preflight: report everything missing at once ---------------------------
$manifestPath = Join-Path $Bundle 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "No manifest.json in $Bundle - pass -Bundle <transfer folder>" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$missing = New-Object System.Collections.Generic.List[string]
foreach ($tool in 'git', 'node', 'npx', 'docker') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { $missing.Add($tool) }
}
$python = Find-Python312
if (-not $python) { $missing.Add('Python 3.12 (3.14 does not work: pydantic-core has no wheels)') }
if ($missing.Count -gt 0) { throw "Install these first, then re-run: $($missing -join ', ')" }

$prevPref = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
docker info 2>&1 | Out-Null
$dockerCode = $LASTEXITCODE
$ErrorActionPreference = $prevPref
if ($dockerCode -ne 0) { throw 'Docker is installed but not running - start Docker Desktop, wait for it, re-run' }

# --- 2. Bundle integrity -------------------------------------------------------
Write-Step "verifying $($manifest.files.Count) files against the manifest"
foreach ($f in $manifest.files) {
  $path = Join-Path $Bundle $f.path
  if (-not (Test-Path -LiteralPath $path)) { throw "Bundle is missing $($f.path)" }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $f.sha256) { throw "Bundle file is corrupt: $($f.path)" }
}
Write-Step 'bundle intact'

# --- 3. Code -------------------------------------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) {
  Invoke-Native 'cloning repository' { git clone $manifest.gitRemote $RepoRoot }
  Invoke-Native "checking out $($manifest.gitBranch)" { git -C $RepoRoot checkout $manifest.gitBranch }
}
$head = git -C $RepoRoot rev-parse HEAD
if ($head -ne $manifest.gitHead) { Write-Warning "Repo is at $head, the old laptop was at $($manifest.gitHead)" }

# --- 4. Local files ------------------------------------------------------------
$filesRoot = Join-Path $Bundle 'files'
if (Test-Path -LiteralPath $filesRoot) {
  $base = (Resolve-Path -LiteralPath $filesRoot).Path.TrimEnd('\')
  foreach ($file in Get-ChildItem -LiteralPath $base -Recurse -File -Force) {
    $rel = $file.FullName.Substring($base.Length + 1)
    $target = Join-Path $RepoRoot $rel
    if ((Test-Path -LiteralPath $target) -and -not $Force) {
      if ((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) {
        Write-Warning "Kept existing $rel (differs from bundle; -Force replaces it)"
      }
      continue
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  }
  Write-Step 'local files restored'
}

# The Vertex key path is absolute, so it has to follow the repo.
$apiEnv = Join-Path $RepoRoot 'apps\api\.env'
$keyFile = Join-Path $RepoRoot 'secrets\vertex-sa.json'
if ((Test-Path -LiteralPath $apiEnv) -and (Test-Path -LiteralPath $keyFile)) {
  $text = [IO.File]::ReadAllText($apiEnv)
  $line = 'GOOGLE_APPLICATION_CREDENTIALS="' + ($keyFile -replace '\\', '/') + '"'
  $updated = [regex]::Replace($text, '(?m)^GOOGLE_APPLICATION_CREDENTIALS=.*?(?=\r?$)', $line.Replace('$', '$$'))
  if ($updated -cne $text) {
    [IO.File]::WriteAllText($apiEnv, $updated, (New-Object Text.UTF8Encoding($false)))
    Write-Step 'updated Vertex key path in apps/api/.env'
  }
}

# --- 5. Dependencies -----------------------------------------------------------
Push-Location $RepoRoot
try {
  Invoke-Native "installing Node packages with $NpmPin" { npx --yes $NpmPin ci }
  Invoke-Native 'building shared package' { npx --yes $NpmPin run build --workspace=@careeros/shared }
} finally { Pop-Location }

$renderer = Join-Path $RepoRoot 'services\renderer'
if (Test-Path -LiteralPath (Join-Path $renderer 'package.json')) {
  Push-Location $renderer
  try { Invoke-Native 'installing renderer packages' { npx --yes $NpmPin install } } finally { Pop-Location }
}

$scraper = Join-Path $RepoRoot 'apps\scraper'
$venvPython = Join-Path $scraper '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
  Invoke-Native 'creating scraper virtualenv (Python 3.12)' { & $python -m venv (Join-Path $scraper '.venv') }
}
Invoke-Native 'installing scraper packages' { & $venvPython -m pip install --quiet -r (Join-Path $scraper 'requirements.txt') }

# --- 6. Infrastructure ---------------------------------------------------------
Push-Location $RepoRoot
try { Invoke-Native 'starting Postgres, Redis and MinIO' { docker compose -p $ComposeProject up -d --wait } } finally { Pop-Location }

# --- 7. Database ---------------------------------------------------------------
$existing = [int](Invoke-Psql "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';").Trim()
$restored = $false
if ($existing -gt 0) {
  Write-Warning "Database already has $existing tables - leaving it alone, not restoring"
} else {
  $dumpFile = Join-Path $Bundle "database\$($manifest.dump)"
  Write-Step "restoring $($manifest.dump) (several minutes)"
  Invoke-Native 'copying dump into container' { docker cp $dumpFile "${pg}:/tmp/restore.dump" }
  # pg_restore exits non-zero on harmless warnings; the row counts below decide.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  docker exec $pg pg_restore -U careeros -d careeros --no-owner --no-acl /tmp/restore.dump 2>&1 |
    ForEach-Object { "$_" } | Where-Object { $_ -match 'error' } | Select-Object -First 20 | ForEach-Object { Write-Warning $_ }
  docker exec $pg rm -f /tmp/restore.dump 2>&1 | Out-Null
  $ErrorActionPreference = $prev
  $restored = $true
}

Push-Location (Join-Path $RepoRoot 'apps\api')
try {
  Invoke-Native 'generating Prisma client' { npx --yes prisma generate }
  Invoke-Native 'applying any newer migrations' { npx --yes prisma migrate deploy }
} finally { Pop-Location }

$mismatches = New-Object System.Collections.Generic.List[string]
if ($restored) {
  foreach ($p in $manifest.tableCounts.PSObject.Properties) {
    $actual = [int64](Invoke-Psql "SELECT count(*) FROM `"$($p.Name)`";").Trim()
    if ($actual -ne [int64]$p.Value) { $mismatches.Add("$($p.Name): expected $($p.Value), got $actual") }
  }
  if ($mismatches.Count -gt 0) {
    $mismatches | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    throw "Restore FAILED - $($mismatches.Count) table(s) differ from the old laptop"
  }
  $vectors = (Invoke-Psql 'SELECT count(*) FROM job_embeddings WHERE vector IS NOT NULL;').Trim()
  Write-Step "$(@($manifest.tableCounts.PSObject.Properties).Count) tables match; $vectors embeddings readable"
}

# --- 8. MinIO ------------------------------------------------------------------
$minioDir = Join-Path $Bundle 'minio'
if ((Test-Path -LiteralPath $minioDir) -and $manifest.minioObjects -gt 0) {
  Invoke-Native 'mc alias' { docker exec $minio mc alias set local http://127.0.0.1:9000 careeros careeros123 }
  Invoke-Native 'creating bucket' { docker exec $minio mc mb --ignore-existing local/careeros }
  Invoke-Native 'clearing import dir' { docker exec $minio rm -rf /tmp/minio-import }
  Invoke-Native 'copying objects into container' { docker cp $minioDir "${minio}:/tmp/minio-import" }
  Invoke-Native 'restoring objects' { docker exec $minio mc mirror --quiet --overwrite /tmp/minio-import local/careeros }
  Invoke-Native 'clearing import dir' { docker exec $minio rm -rf /tmp/minio-import }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $objectCount = @(docker exec $minio mc find local/careeros --name '*' 2>$null).Count
  $ErrorActionPreference = $prev
  if ($objectCount -lt $manifest.minioObjects) { throw "MinIO has $objectCount objects, expected $($manifest.minioObjects)" }
  Write-Step "restored $objectCount MinIO object(s)"
}

# --- 9. Per-machine setup that never travels -----------------------------------
# Claude Code names its project folder after the repo path, so the slug comes from
# the NEW path. Existing files win: this may run after Claude Code is already in use.
function Copy-Missing([string]$source, [string]$target) {
  if (-not (Test-Path -LiteralPath $source)) { return 0 }
  $base = (Resolve-Path -LiteralPath $source).Path.TrimEnd('\')
  $copied = 0
  foreach ($file in Get-ChildItem -LiteralPath $base -Recurse -File -Force) {
    $dest = Join-Path $target $file.FullName.Substring($base.Length + 1)
    if (Test-Path -LiteralPath $dest) { continue }
    New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $dest
    $copied++
  }
  return $copied
}

$claudeHome = Join-Path $UserHome '.claude'
$slug = $RepoRoot -replace '[^A-Za-z0-9]', '-'
$n = Copy-Missing (Join-Path $Bundle 'claude\project') (Join-Path $claudeHome "projects\$slug")
Write-Step "Claude memory and session history: $n file(s) restored"
$n = Copy-Missing (Join-Path $Bundle 'claude\skills') (Join-Path $claudeHome 'skills')
Write-Step "Claude skills: $n file(s) restored"
$n = Copy-Missing (Join-Path $Bundle 'claude\home') $claudeHome
Write-Step "Claude global settings: $n file(s) restored"

$memDbSource = Join-Path $Bundle 'claude\claude-mem.db'
if (Test-Path -LiteralPath $memDbSource) {
  $memDir = Join-Path $UserHome '.claude-mem'
  New-Item -ItemType Directory -Force -Path $memDir | Out-Null
  $memDb = Join-Path $memDir 'claude-mem.db'
  if (Test-Path -LiteralPath $memDb) {
    Copy-Item -LiteralPath $memDbSource -Destination (Join-Path $memDir 'claude-mem.db.from-old-laptop') -Force
    Write-Warning 'claude-mem already has a database. Old laptop copy saved as claude-mem.db.from-old-laptop; to use it, close all Claude Code sessions and rename it over claude-mem.db.'
  } else {
    Copy-Item -LiteralPath $memDbSource -Destination $memDb
    Write-Step 'claude-mem database restored'
  }
}

$suffix = if ($Rehearsal) { '-Rehearsal' } else { '' }
$tasks = @(
  @{ Name = 'CareerOS-Backup'; Script = 'backup.ps1'; Trigger = (New-ScheduledTaskTrigger -Daily -At '02:00'); Limit = 2; Enabled = $true },
  @{ Name = 'CareerOS-Phase0-Baseline'; Script = 'phase0-baseline.ps1'; Trigger = (New-ScheduledTaskTrigger -Daily -At '23:45'); Limit = 1; Enabled = $true },
  @{ Name = 'CareerOS-Stack-Watchdog'; Script = 'ensure-stack.ps1'
     Trigger = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)); Limit = 1; Enabled = $false }
)
try {
  foreach ($t in $tasks) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $RepoRoot "scripts\$($t.Script)")`"" -WorkingDirectory $RepoRoot
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit (New-TimeSpan -Hours $t.Limit)
    $name = "$($t.Name)$suffix"
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $t.Trigger -Settings $settings `
      -User $env:USERNAME -RunLevel Limited -Force | Out-Null
    if (-not $t.Enabled -or $Rehearsal) { Disable-ScheduledTask -TaskName $name | Out-Null }
    Write-Step "scheduled task registered: $name"
  }
} catch {
  Write-Warning "Scheduled tasks not registered: $($_.Exception.Message). Re-run from an Administrator PowerShell."
}

Write-Host ''
Write-Host 'IMPORT VERIFIED - code, files, database and MinIO are in place.' -ForegroundColor Green
Write-Host "Start the app:  powershell -ExecutionPolicy Bypass -File `"$(Join-Path $RepoRoot 'scripts\ensure-stack.ps1')`""
Write-Host 'Before starting it here, stop CareerOS on the old laptop: two running copies send duplicate Telegram messages and double AI spend.'
Write-Host 'Sign in to OneDrive on this laptop, or backups stay local only.'
Write-Host 'Install the claude-mem plugin, then open Claude Code in the project and say: read docs/HANDOFF.md and continue.'
