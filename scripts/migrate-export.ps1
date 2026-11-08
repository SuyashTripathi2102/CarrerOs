<#
.SYNOPSIS
  Packs everything GitHub does not have into one folder for a laptop move.

.DESCRIPTION
  Code travels through git. This bundles the rest: .env files, the Vertex key,
  the newest Postgres dump, MinIO objects (backup.ps1 does not cover them),
  gitignored seeds and personal files, uncommitted changes, and Claude's memory,
  session history and skills. Every file is hashed and every table counted into manifest.json, so
  migrate-import.ps1 can prove the bundle arrived intact and the restore is
  complete rather than assume it.

  node_modules, .venv and build output are skipped on purpose: ~1.5 GB across
  67,000+ files that are slow to copy and that the import rebuilds.

  The bundle contains live credentials. Encrypt the card before copying it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/backup.ps1
  powershell -ExecutionPolicy Bypass -File scripts/migrate-export.ps1 -Destination D:\CareerOS-Transfer
#>
param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent),
  [string]$BackupPath = $(if (Test-Path 'D:\CareerOS-Backups') { 'D:\CareerOS-Backups' } else { Join-Path $env:USERPROFILE 'CareerOS-Backups' }),
  [int]$MaxDumpAgeHours = 24,
  [string]$ComposeProject = 'careeros'
)

$ErrorActionPreference = 'Stop'
$pg = "$ComposeProject-postgres-1"
$minio = "$ComposeProject-minio-1"

function Write-Step($msg) { Write-Host "[export] $msg" }

# PowerShell 5.1 can turn a native command's stderr into a terminating error, and
# docker and mc write progress there. The exit code is the real verdict.
function Invoke-Native([string]$label, [scriptblock]$cmd) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 0
  try { & $cmd | Out-Null; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
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

function Copy-Into([string]$source, [string]$relative) {
  $target = Join-Path $Destination $relative
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}

# --- 1. Refuse to build a bundle that would silently lose something ----------
if ((Test-Path $Destination) -and (Get-ChildItem -LiteralPath $Destination -Force | Select-Object -First 1)) {
  throw "$Destination is not empty - use a new folder so old files cannot mix in"
}
$unpushed = @(git -C $RepoRoot log --branches --not --remotes --oneline)
if ($unpushed.Count -gt 0) { throw "$($unpushed.Count) commit(s) are not on GitHub - push them first" }

try {
  Invoke-WebRequest -Uri 'http://localhost:3001/api/health' -UseBasicParsing -TimeoutSec 3 | Out-Null
  throw 'API_RUNNING'
} catch {
  if ($_.Exception.Message -eq 'API_RUNNING') { throw 'The API is running - stop it first so the table counts match the dump' }
}
$workers = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*tsx*cli.mjs*watch*' })
if ($workers.Count -gt 0) { throw 'Workers are running - stop them first so the table counts match the dump' }

$dump = Get-ChildItem -LiteralPath $BackupPath -Filter 'careeros_*.dump' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $dump) { throw "No dump in $BackupPath - run scripts/backup.ps1 first" }
$ageHours = ((Get-Date) - $dump.LastWriteTime).TotalHours
if ($ageHours -gt $MaxDumpAgeHours) {
  throw "Newest dump is $([math]::Round($ageHours, 1)) h old - run scripts/backup.ps1 first"
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null

# --- 2. Everything git does not carry ----------------------------------------
# `ls-files -o` lists untracked AND ignored files, so a new personal file is
# picked up by default instead of depending on someone remembering to list it.
$rebuildable = '(^|/)(node_modules|\.venv|\.next|dist|\.turbo|__pycache__)/|\.tsbuildinfo$|next-env\.d\.ts$'
$staleSecrets = '\.env\.bak|\.old$'
$local = @(git -C $RepoRoot ls-files -o) + @(git -C $RepoRoot diff --name-only HEAD) |
  Where-Object { $_ -and $_ -notmatch $rebuildable -and $_ -notmatch $staleSecrets } | Sort-Object -Unique
foreach ($rel in $local) {
  $source = Join-Path $RepoRoot $rel
  if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Into $source "files/$rel" }
}
Write-Step "copied $($local.Count) local file(s)"

# --- 3. Database --------------------------------------------------------------
Copy-Into $dump.FullName "database/$($dump.Name)"
$profileJson = Join-Path $BackupPath ($dump.Name -replace '^careeros_(.*)\.dump$', 'profile_$1.json')
if (Test-Path -LiteralPath $profileJson) { Copy-Into $profileJson "database/$(Split-Path $profileJson -Leaf)" }
Write-Step "copied $($dump.Name)"

$tables = (Invoke-Psql "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;") |
  Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() }
$counts = [ordered]@{}
foreach ($t in $tables) { $counts[$t] = [int64](Invoke-Psql "SELECT count(*) FROM `"$t`";").Trim() }
Write-Step "counted $($counts.Count) tables"

# --- 4. MinIO -----------------------------------------------------------------
# Resume PDFs live here and resume_versions."fileKey" points at them. mc mirror
# exports plain objects, which unlike the raw volume does not depend on the
# minio:latest image matching on the other machine.
Invoke-Native 'mc alias' { docker exec $minio mc alias set local http://127.0.0.1:9000 careeros careeros123 }
Invoke-Native 'clear export dir' { docker exec $minio rm -rf /tmp/minio-export }
Invoke-Native 'mc mirror' { docker exec $minio mc mirror --quiet local/careeros /tmp/minio-export }
Invoke-Native 'docker cp minio' { docker cp "${minio}:/tmp/minio-export" (Join-Path $Destination 'minio') }
Invoke-Native 'clear export dir' { docker exec $minio rm -rf /tmp/minio-export }
$objects = @(Get-ChildItem -LiteralPath (Join-Path $Destination 'minio') -Recurse -File).Count
Write-Step "exported $objects MinIO object(s)"

# --- 5. Claude's working context ----------------------------------------------
# Login tokens stay behind on purpose (.credentials.json, .claude.json). Build
# output inside skills is skipped: 1.3 GB shrinks to about 190 MB of source.
$claudeHome = Join-Path $env:USERPROFILE '.claude'
$slug = $RepoRoot -replace '[^A-Za-z0-9]', '-'

function Copy-Tree([string]$source, [string]$relative, [string]$exclude = '') {
  if (-not (Test-Path -LiteralPath $source)) { Write-Warning "Not found: $source"; return }
  $base = (Resolve-Path -LiteralPath $source).Path.TrimEnd('\')
  Get-ChildItem -LiteralPath $base -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($base.Length + 1)
    if (-not $exclude -or $rel -notmatch $exclude) { Copy-Into $_.FullName "$relative/$($rel.Replace('\', '/'))" }
  }
}

Copy-Tree (Join-Path $claudeHome "projects\$slug") 'claude/project'
Copy-Tree (Join-Path $claudeHome 'skills') 'claude/skills' '(^|\\)(node_modules|\.git|\.trash|dist|\.venv|__pycache__)\\'
foreach ($name in 'CLAUDE.md', 'settings.json', 'INSTALLED_TOOLS.md') {
  $source = Join-Path $claudeHome $name
  if (Test-Path -LiteralPath $source) { Copy-Into $source "claude/home/$name" }
}
Write-Step 'copied Claude memory, session history and skills'

# claude-mem keeps recent writes in a WAL while its worker runs, so a plain file
# copy can be inconsistent. SQLite's backup API takes a consistent snapshot.
$memDb = Join-Path $env:USERPROFILE '.claude-mem\claude-mem.db'
if ((Test-Path -LiteralPath $memDb) -and (Get-Command python -ErrorAction SilentlyContinue)) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Destination 'claude') | Out-Null
  Invoke-Native 'claude-mem snapshot' {
    python -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1],timeout=60); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' $memDb (Join-Path $Destination 'claude\claude-mem.db')
  }
  Write-Step 'snapshotted claude-mem database'
} else {
  Write-Warning 'claude-mem database not copied (database or python not found)'
}

# --- 6. Import script and instructions, so the card is self-contained ---------
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'migrate-import.ps1') -Destination $Destination -Force
@'
CareerOS laptop transfer bundle. Contains live credentials - keep it encrypted.

On the new laptop:
1. Install Git, Node 24, Python 3.12 and Docker Desktop. Start Docker Desktop.
2. Copy this folder off the card to the laptop.
3. In PowerShell, from this folder:
   powershell -ExecutionPolicy Bypass -File .\migrate-import.ps1 -RepoRoot D:\CarrerOs
   (Use another path if the laptop has no D: drive.)
4. Keep the old laptop untouched until the import says IMPORT VERIFIED.
5. Open Claude Code in the project and say: read docs/HANDOFF.md and continue.
'@ | Set-Content -LiteralPath (Join-Path $Destination 'README.txt') -Encoding ASCII

# --- 7. Manifest --------------------------------------------------------------
$root = (Resolve-Path -LiteralPath $Destination).Path.TrimEnd('\')
$files = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object {
  [ordered]@{
    path   = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    size   = $_.Length
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
})
$manifest = [ordered]@{
  createdAt    = (Get-Date).ToString('o')
  sourceRepo   = $RepoRoot
  gitRemote    = (git -C $RepoRoot remote get-url origin)
  gitBranch    = (git -C $RepoRoot rev-parse --abbrev-ref HEAD)
  gitHead      = (git -C $RepoRoot rev-parse HEAD)
  dump         = $dump.Name
  minioObjects = $objects
  tableCounts  = $counts
  files        = $files
}
[IO.File]::WriteAllText((Join-Path $root 'manifest.json'), ($manifest | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))

$totalMb = [math]::Round((($files | ForEach-Object { $_.size }) | Measure-Object -Sum).Sum / 1MB, 1)
Write-Host ''
Write-Host "EXPORT COMPLETE - $($files.Count) files, $totalMb MB -> $root" -ForegroundColor Green
Write-Warning 'This folder contains live credentials. Encrypt the card (BitLocker To Go) before copying it there.'
