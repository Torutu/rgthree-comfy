<#
.SYNOPSIS
  Development workflow for rgthree-comfy: build, check, deploy to ComfyUI, back up, restore.

.DESCRIPTION
  Works with Windows PowerShell 5.1 and PowerShell 7. The Makefile in the repo root is a thin
  wrapper around this script, so `make deploy` and `scripts\dev.ps1 deploy` do the same thing.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev.ps1 <command> [options]

  Run `scripts\dev.ps1 help` for the command list.

  Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string] $Command = 'help',
  # The installed custom node to deploy into (default: Comfy Desktop location, or $env:RGTHREE_INSTALL_DIR).
  [string] $InstallDir,
  # Where backups are kept (default: %LOCALAPPDATA%\rgthree-comfy-dev\backups, or $env:RGTHREE_BACKUP_DIR).
  [string] $BackupRoot,
  # restore: a backup id (folder name), or 'original' for the newest backup of a non-dev install.
  [string] $Backup,
  # reset-upstream: a commit hash, or 'main' for the latest upstream main.
  [string] $Ref,
  # Skip the typed confirmation prompts.
  [switch] $Yes
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
# Native tools (wsl.exe, git) print UTF-8; decode it as UTF-8.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# ------------------------------------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------------------------------------

$UpstreamUrl = 'https://github.com/rgthree/rgthree-comfy'
# The registry release that was installed before any dev deploy. Checked on 2026-10-19: the installed
# files were byte-identical to this commit (except __pycache__ and the registry's .tracking file).
$PinnedUpstreamCommit = '16e329820fadb08480dca27e060e8da7e8f432ed'
$PinnedUpstreamLabel = 'rgthree-comfy 1.0.2610050029 (Comfy Registry release)'

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
if (-not $InstallDir) { $InstallDir = $env:RGTHREE_INSTALL_DIR }
if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA 'Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes\rgthree-comfy'
}
$ToolRoot = Join-Path $env:LOCALAPPDATA 'rgthree-comfy-dev'
if (-not $BackupRoot) { $BackupRoot = $env:RGTHREE_BACKUP_DIR }
if (-not $BackupRoot) { $BackupRoot = Join-Path $ToolRoot 'backups' }
$UpstreamCache = Join-Path $ToolRoot 'upstream-cache'
$TempRoot = Join-Path $ToolRoot 'tmp'
$MarkerName = '.rgthree-dev-deploy.json'
# `make sandbox`: a second, throw-away ComfyUI (own folders, port, in-memory DB, CPU only) that runs
# the dev build, for testing without touching the real install.
$SandboxDir = Join-Path $ToolRoot 'sandbox'
$SandboxPort = 8288

# What `deploy` copies. Everything else in the installed folder is left untouched.
$ManagedFiles = @('__init__.py', 'prestartup_script.py', 'pyproject.toml', 'requirements.txt',
  'rgthree_config.json.default', 'README.md', 'LICENSE')
$ManagedDirs = @('py', 'web', 'src_web', 'docs')
# Never copied by deploy and never deleted by restore/reset (user data and registry metadata).
$UserDataNames = @('rgthree_config.json', 'userdata')
# Skipped everywhere: generated caches, dev-only test bundles, build leftovers.
$SkipDirNames = @('__pycache__', 'node_modules', '.git')
$SkipRelDirs = @('web\comfyui\tests', 'web\comfyui\testing', 'web\scripts_comfy')

# ------------------------------------------------------------------------------------------------
# Output helpers
# ------------------------------------------------------------------------------------------------

function Write-Step([string] $Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok([string] $Text) { Write-Host "OK   $Text" -ForegroundColor Green }
function Write-Info([string] $Text) { Write-Host "     $Text" }
function Write-Warn([string] $Text) { Write-Host "WARN $Text" -ForegroundColor Yellow }
function Stop-WithError([string] $Text) {
  Write-Host "FAIL $Text" -ForegroundColor Red
  exit 1
}

function Confirm-Typed([string] $Question, [string] $Expected) {
  if ($Yes) { Write-Info "Confirmation skipped (-Yes)."; return }
  Write-Host ''
  Write-Host $Question -ForegroundColor Yellow
  Write-Host "Type '$Expected' to continue, anything else cancels: " -NoNewline
  if ([Console]::IsInputRedirected) { $answer = [Console]::In.ReadLine() } else { $answer = Read-Host }
  if ($null -eq $answer -or $answer.Trim() -ne $Expected) {
    Write-Host 'Cancelled. Nothing was changed.' -ForegroundColor Yellow
    exit 2
  }
}

# ------------------------------------------------------------------------------------------------
# Path and file helpers
# ------------------------------------------------------------------------------------------------

function Get-NormalPath([string] $Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Test-IsInside([string] $Child, [string] $Parent) {
  $c = (Get-NormalPath $Child) + '\'
  $p = (Get-NormalPath $Parent) + '\'
  return $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}

function Test-IsReparsePoint([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Get-PyprojectField([string] $Dir, [string] $Field) {
  $file = Join-Path $Dir 'pyproject.toml'
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  foreach ($line in Get-Content -LiteralPath $file) {
    if ($line -match ('^\s*' + [regex]::Escape($Field) + '\s*=\s*"([^"]*)"')) { return $Matches[1] }
  }
  return $null
}

function Test-SkippedRel([string] $Rel) {
  foreach ($part in $Rel.Split('\')) {
    if ($SkipDirNames -contains $part) { return $true }
  }
  foreach ($d in $SkipRelDirs) {
    if ($Rel.StartsWith($d + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $Rel.EndsWith('.pyc', [StringComparison]::OrdinalIgnoreCase)
}

function Test-UserDataRel([string] $Rel) {
  $first = $Rel.Split('\')[0]
  return ($UserDataNames -contains $first)
}

# Relative paths (with '\') of every file under $Root, minus skipped paths.
function Get-RelFiles([string] $Root) {
  $rootFull = Get-NormalPath $Root
  $list = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path -LiteralPath $rootFull)) { return $list }
  foreach ($f in Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force) {
    $rel = $f.FullName.Substring($rootFull.Length).TrimStart('\')
    if (-not (Test-SkippedRel $rel)) { $list.Add($rel) }
  }
  return $list
}

# The files `deploy` manages under $Root.
function Get-ManagedRelFiles([string] $Root) {
  $list = New-Object System.Collections.Generic.List[string]
  foreach ($f in $ManagedFiles) {
    if (Test-Path -LiteralPath (Join-Path $Root $f) -PathType Leaf) { $list.Add($f) }
  }
  foreach ($d in $ManagedDirs) {
    $dirPath = Join-Path $Root $d
    if (Test-Path -LiteralPath $dirPath) {
      foreach ($rel in Get-RelFiles $dirPath) { $list.Add("$d\$rel") }
    }
  }
  return $list
}

function Get-HashTable([string] $Root, $RelFiles) {
  $table = @{}
  foreach ($rel in $RelFiles) {
    $table[$rel] = (Get-FileHash -LiteralPath (Join-Path $Root $rel) -Algorithm SHA256).Hash
  }
  return $table
}

# Compares two {rel -> hash} tables. Returns added (only in A), changed, removed (only in B).
function Compare-HashTables($A, $B) {
  $added = @(); $changed = @(); $removed = @()
  foreach ($k in $A.Keys) {
    if (-not $B.ContainsKey($k)) { $added += $k }
    elseif ($A[$k] -ne $B[$k]) { $changed += $k }
  }
  foreach ($k in $B.Keys) { if (-not $A.ContainsKey($k)) { $removed += $k } }
  return [pscustomobject]@{
    Added = @($added | Sort-Object); Changed = @($changed | Sort-Object); Removed = @($removed | Sort-Object)
    Count = $added.Count + $changed.Count + $removed.Count
  }
}

function Write-DiffSummary($Diff, [string] $AddedLabel, [string] $RemovedLabel, [int] $Max = 25) {
  $rows = @()
  foreach ($p in $Diff.Added) { $rows += "  + $p   ($AddedLabel)" }
  foreach ($p in $Diff.Changed) { $rows += "  ~ $p" }
  foreach ($p in $Diff.Removed) { $rows += "  - $p   ($RemovedLabel)" }
  $rows | Select-Object -First $Max | ForEach-Object { Write-Host $_ }
  if ($rows.Count -gt $Max) { Write-Info "... and $($rows.Count - $Max) more" }
}

function Invoke-Robocopy([string[]] $RoboArgs) {
  & robocopy.exe @RoboArgs | Out-Null
  $code = $LASTEXITCODE
  if ($code -ge 8) { Stop-WithError "robocopy failed with exit code $code (args: $($RoboArgs -join ' '))" }
  return $code
}

# What needs reloading after files change.
function Write-ReloadAdvice($ChangedRelPaths) {
  $py = @($ChangedRelPaths | Where-Object { $_ -like '*.py' -or $_ -eq 'pyproject.toml' -or $_ -eq 'requirements.txt' })
  $web = @($ChangedRelPaths | Where-Object { $_ -like 'web\*' })
  Write-Step 'What to reload'
  if ($py.Count -gt 0) {
    Write-Warn "$($py.Count) Python file(s) changed: RESTART ComfyUI (Python modules load once at startup)."
  }
  if ($web.Count -gt 0) {
    Write-Info "$($web.Count) web file(s) changed: reload the ComfyUI page. ComfyUI serves .js/.css with"
    Write-Info "'Cache-Control: no-store' (ComfyUI\middleware\cache_middleware.py), so a normal reload is enough."
  }
  if ($py.Count -eq 0 -and $web.Count -eq 0) { Write-Info 'No runtime files changed.' }
}

# Runs a native program and returns its exit code and output lines. Windows PowerShell 5.1 turns a
# native program's redirected stderr into error records, which $ErrorActionPreference='Stop' would
# make fatal; git and wsl.exe print normal progress on stderr, so relax it for the call.
function Invoke-Native([string] $Exe, [string[]] $ArgList) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $lines = @(& $Exe @ArgList 2>&1 | ForEach-Object { ConvertTo-Line $_ }) }
  finally { $ErrorActionPreference = $old }
  return [pscustomobject]@{ Code = $LASTEXITCODE; Lines = $lines }
}

# A stderr line arrives as an ErrorRecord; "$record" of an empty line prints the exception type name.
function ConvertTo-Line($Item) {
  if ($Item -is [System.Management.Automation.ErrorRecord]) { return [string]$Item.Exception.Message }
  return [string]$Item
}

# ------------------------------------------------------------------------------------------------
# Repo environment (the repo usually lives in WSL: \\wsl.localhost\<distro>\home\...)
# ------------------------------------------------------------------------------------------------

function Get-WslRepo {
  if ($RepoRoot -match '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$') {
    return [pscustomobject]@{ Distro = $Matches[1]; Path = '/' + ($Matches[2] -replace '\\', '/') }
  }
  return $null
}

# Runs `git <args>` in the repo's own environment and returns the output lines.
function Invoke-RepoGit([string[]] $GitArgs, [switch] $AllowFail) {
  $wsl = Get-WslRepo
  if ($wsl) { $r = Invoke-Native 'wsl.exe' (@('-d', $wsl.Distro, '--cd', $wsl.Path, '--', 'git') + $GitArgs) }
  else { $r = Invoke-Native 'git.exe' (@('-C', $RepoRoot) + $GitArgs) }
  if ($r.Code -ne 0 -and -not $AllowFail) {
    Stop-WithError ("git $($GitArgs -join ' ') failed:`n" + ($r.Lines -join "`n"))
  }
  return $r.Lines
}

# Runs a task from scripts/wsl-run.sh (setup|check|build) with live output.
function Invoke-RepoTask([string] $Task) {
  $wsl = Get-WslRepo
  if ($wsl) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & wsl.exe -d $wsl.Distro --cd $wsl.Path -- bash scripts/wsl-run.sh $Task 2>&1 | ForEach-Object { Write-Host (ConvertTo-Line $_) } }
    finally { $ErrorActionPreference = $old }
    return $LASTEXITCODE
  }
  # Windows-native clone.
  switch ($Task) {
    'build' {
      Write-Warn '__build__.py rewrites imports assuming "/" path separators, so it does not build'
      Write-Warn 'correctly with Windows paths. Build from WSL, Linux or macOS instead.'
      return 2
    }
    'setup' {
      Push-Location $RepoRoot
      try { & npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -eq 0) { & node scripts/patch-frontend-types.mjs } }
      finally { Pop-Location }
      return $LASTEXITCODE
    }
    'check' {
      Push-Location $RepoRoot
      try {
        & node scripts/patch-frontend-types.mjs | Out-Null
        & node ./node_modules/typescript/bin/tsc --noEmit -p .; if ($LASTEXITCODE -ne 0) { return $LASTEXITCODE }
        & node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test "tests/node/*.test.ts"; if ($LASTEXITCODE -ne 0) { return $LASTEXITCODE }
        $env:PYTHONDONTWRITEBYTECODE = '1'; & python -m unittest discover -s tests/python -v; return $LASTEXITCODE
      } finally { Pop-Location }
    }
  }
  return 2
}

function Get-RepoState {
  $branch = (Invoke-RepoGit @('rev-parse', '--abbrev-ref', 'HEAD') -AllowFail | Select-Object -First 1)
  $commit = (Invoke-RepoGit @('rev-parse', 'HEAD') -AllowFail | Select-Object -First 1)
  $dirty = @(Invoke-RepoGit @('status', '--porcelain') -AllowFail)
  return [pscustomobject]@{ Branch = $branch; Commit = $commit; DirtyLines = $dirty; Dirty = ($dirty.Count -gt 0) }
}

# The build regenerates web/ from src_web/. Stale = some .ts is newer than the .js built from it.
function Get-StaleBuildFiles {
  $src = Join-Path $RepoRoot 'src_web'
  $stale = @()
  foreach ($f in Get-ChildItem -LiteralPath $src -Recurse -File -Filter *.ts) {
    $rel = $f.FullName.Substring($src.Length).TrimStart('\')
    if ($rel -like '*.d.ts' -or $rel -like 'typings\*' -or $rel -like 'scripts_comfy\*' -or
      $rel -like 'comfyui\tests\*' -or $rel -like 'comfyui\testing\*') { continue }
    $js = Join-Path (Join-Path $RepoRoot 'web') ($rel -replace '\.ts$', '.js')
    if (-not (Test-Path -LiteralPath $js) -or (Get-Item -LiteralPath $js).LastWriteTimeUtc -lt $f.LastWriteTimeUtc) {
      $stale += $rel
    }
  }
  return $stale
}

# ------------------------------------------------------------------------------------------------
# Safety checks
# ------------------------------------------------------------------------------------------------

function Assert-Source {
  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '__init__.py'))) { Stop-WithError "No __init__.py in $RepoRoot" }
  if ((Get-PyprojectField $RepoRoot 'name') -ne 'rgthree-comfy') { Stop-WithError "$RepoRoot is not an rgthree-comfy checkout" }
  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'web\comfyui\rgthree.js'))) { Stop-WithError 'web\comfyui\rgthree.js is missing; run make build' }
}

function Assert-InstallDir([switch] $MustExist) {
  $parent = Split-Path -Parent (Get-NormalPath $InstallDir)
  if ((Split-Path -Leaf $parent) -ne 'custom_nodes') {
    Stop-WithError "Install dir must be inside a ComfyUI 'custom_nodes' folder: $InstallDir"
  }
  if (Test-Path -LiteralPath $InstallDir) {
    if ((Get-PyprojectField $InstallDir 'name') -ne 'rgthree-comfy') {
      Stop-WithError "$InstallDir exists but is not rgthree-comfy (pyproject.toml name). Refusing to touch it."
    }
  } elseif ($MustExist) {
    Stop-WithError "Install dir not found: $InstallDir"
  }
}

function Assert-BackupRootSafe {
  $customNodes = Split-Path -Parent (Get-NormalPath $InstallDir)
  if (Test-IsInside $BackupRoot $customNodes) {
    Stop-WithError "Backups must not live inside custom_nodes (ComfyUI would load them as node packs): $BackupRoot"
  }
  if (Test-IsInside $BackupRoot $RepoRoot) { Stop-WithError "Backups must not live inside the repo: $BackupRoot" }
}

# Refuses when source and destination are the same folder, nested, or linked to each other.
function Assert-NotSameDirectory {
  $src = Get-NormalPath $RepoRoot
  $dst = Get-NormalPath $InstallDir
  if ($src -ieq $dst) { Stop-WithError "Source and destination are the same folder: $src" }
  if ((Test-IsInside $dst $src) -or (Test-IsInside $src $dst)) { Stop-WithError "Source and destination are nested: $src / $dst" }
  if (Test-IsReparsePoint $dst) {
    Stop-WithError "$dst is a symlink/junction. If it points at your repo, ComfyUI already runs your dev code; deploy is not needed."
  }
  if (-not (Test-Path -LiteralPath $dst)) { return }
  # Paths can differ yet reach the same folder (mounts, links). Prove it with a temporary file.
  $sentinelName = '.rgthree-dev-sentinel-' + [guid]::NewGuid().ToString('N')
  $sentinel = Join-Path $src $sentinelName
  try {
    Set-Content -LiteralPath $sentinel -Value 'sentinel' -Encoding ASCII
    if (Test-Path -LiteralPath (Join-Path $dst $sentinelName)) {
      Stop-WithError "Source and destination resolve to the same folder ($src == $dst)."
    }
  } finally {
    Remove-Item -LiteralPath $sentinel -Force -ErrorAction SilentlyContinue
  }
}

# Copies the deployable files (root files + mirrored py/ web/ src_web/ docs/) from the repo to $Dest.
# Mirroring deletes files in those folders that the repo no longer has; deploy lists them first.
function Copy-ManagedFiles([string] $Dest) {
  New-Item -ItemType Directory -Path $Dest -Force | Out-Null
  foreach ($f in $ManagedFiles) {
    $src = Join-Path $RepoRoot $f
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $Dest $f) -Force }
  }
  foreach ($d in $ManagedDirs) {
    $src = Join-Path $RepoRoot $d
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $xd = @('__pycache__', 'node_modules')
    foreach ($rd in $SkipRelDirs) {
      if ($rd.StartsWith("$d\")) {
        $xd += (Join-Path $src $rd.Substring($d.Length + 1))
        $xd += (Join-Path (Join-Path $Dest $d) $rd.Substring($d.Length + 1))
      }
    }
    $roboArgs = @($src, (Join-Path $Dest $d), '/MIR', '/COPY:DAT', '/DCOPY:T', '/R:1', '/W:1', '/XF', '*.pyc', '/XD') + $xd
    Invoke-Robocopy $roboArgs | Out-Null
  }
}

# ------------------------------------------------------------------------------------------------
# Backups
# ------------------------------------------------------------------------------------------------

function Read-Marker([string] $Dir) {
  $file = Join-Path $Dir $MarkerName
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try { return (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json) } catch { return $null }
}

# Copies the whole installed folder (minus __pycache__) and writes a manifest with SHA-256 hashes.
function New-Backup([string] $Kind) {
  Assert-InstallDir -MustExist
  Assert-BackupRootSafe
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $id = "$stamp-$Kind"
  $dir = Join-Path $BackupRoot $id
  $copy = Join-Path $dir 'rgthree-comfy'
  New-Item -ItemType Directory -Path $copy -Force | Out-Null
  Write-Info "Backing up $InstallDir"
  Write-Info "        to $copy"
  Invoke-Robocopy @($InstallDir, $copy, '/E', '/COPY:DAT', '/DCOPY:T', '/R:1', '/W:1', '/XD', '__pycache__') | Out-Null

  # Verify the copy file-by-file before trusting it.
  $srcFiles = @(Get-RelFiles $InstallDir)
  $srcHashes = Get-HashTable $InstallDir $srcFiles
  $copyHashes = Get-HashTable $copy (Get-RelFiles $copy)
  $diff = Compare-HashTables $srcHashes $copyHashes
  if ($diff.Count -ne 0) {
    Write-DiffSummary $diff 'missing in backup' 'extra in backup'
    Stop-WithError "Backup verification failed: $dir"
  }

  $marker = Read-Marker $InstallDir
  $files = @()
  $bytes = 0
  foreach ($rel in ($srcFiles | Sort-Object)) {
    $size = (Get-Item -LiteralPath (Join-Path $copy $rel)).Length
    $bytes += $size
    $files += [pscustomobject]@{ path = $rel; sha256 = $copyHashes[$rel]; size = $size }
  }
  $manifest = [pscustomobject]@{
    format = 1
    id = $id
    kind = $Kind
    created = (Get-Date).ToString('o')
    installDir = (Get-NormalPath $InstallDir)
    version = (Get-PyprojectField $InstallDir 'version')
    wasDevDeploy = ($null -ne $marker)
    devDeploy = $marker
    fileCount = $files.Count
    totalBytes = $bytes
    files = $files
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $dir 'manifest.json') -Encoding UTF8
  Write-Ok "Backup verified: $($files.Count) files, $([math]::Round($bytes / 1MB, 2)) MB"
  Write-Info "Backup location: $dir"
  return [pscustomobject]@{ Id = $id; Dir = $dir; Copy = $copy }
}

function Get-BackupList {
  if (-not (Test-Path -LiteralPath $BackupRoot)) { return @() }
  $items = @()
  foreach ($d in Get-ChildItem -LiteralPath $BackupRoot -Directory | Sort-Object Name -Descending) {
    $mf = Join-Path $d.FullName 'manifest.json'
    if (-not (Test-Path -LiteralPath $mf)) { continue }
    try { $m = Get-Content -LiteralPath $mf -Raw | ConvertFrom-Json } catch { continue }
    $items += [pscustomobject]@{ Id = $d.Name; Dir = $d.FullName; Copy = (Join-Path $d.FullName 'rgthree-comfy'); Manifest = $m }
  }
  return $items
}

# Checks every file in a backup against its manifest.
function Test-BackupValid($Item) {
  if (-not (Test-Path -LiteralPath $Item.Copy)) { return $false }
  $expected = @{}
  foreach ($f in $Item.Manifest.files) { $expected[$f.path] = $f.sha256 }
  $actual = Get-HashTable $Item.Copy (Get-RelFiles $Item.Copy)
  return ((Compare-HashTables $expected $actual).Count -eq 0)
}

# ------------------------------------------------------------------------------------------------
# Commands
# ------------------------------------------------------------------------------------------------

function Show-Help {
  @"
rgthree-comfy dev workflow  (make <target>  ==  scripts\dev.ps1 <command>)

  help            Show this list.
  setup           npm ci + typings patch (once, and after package-lock.json changes).
  status          Git branch/changes, build freshness, installed version, drift, backups.
  check           Type check, unit tests (Node + Python), Python syntax check.
  build           Run the existing build (__build__.py --no-tests): src_web -> web.
  deploy          Build, back up the installed node, copy py/ web/ src_web/ docs/ + root files,
                  verify every file by SHA-256. Asks first if the install is not a dev deploy.
  backup          Back up the installed node now (verified copy + manifest).
  backups         List backups.
  restore         Option A: put back the newest pre-deploy backup (or BACKUP=<id> / original).
  restore-original  Restore the install as it was before your first dev deploy.
  upstream        Fetch github.com/rgthree/rgthree-comfy main into refs/remotes/upstream/main and
                  show how it differs from your branch. Never merges or touches your files.
  reset-upstream  Option B: replace the installed node with a verified upstream commit
                  (default: pinned $($PinnedUpstreamCommit.Substring(0, 7)) = $PinnedUpstreamLabel; REF=main for latest).
  sandbox         Build, then run the dev build in a separate throw-away ComfyUI on port $SandboxPort
                  (own folders, CPU only). Already running? Just refreshes its files.
  e2e             Browser tests (headless Edge, real clicks) against the sandbox, in Nodes 2.0
                  and classic mode. Needs make sandbox running.
  clean           Delete generated dev artifacts (test bundles, __pycache__, temp folders).

Make variables: INSTALL_DIR=<path>  BACKUP=<id|original>  REF=<commit|main>  YES=1

Paths
  repo     $RepoRoot
  install  $InstallDir
  backups  $BackupRoot
"@ | Write-Host
}

function Invoke-Status {
  Write-Step 'Repository'
  Write-Info "path    $RepoRoot"
  $repo = Get-RepoState
  Write-Info "branch  $($repo.Branch)   commit $($repo.Commit)"
  if ($repo.Dirty) {
    Write-Info "changes $($repo.DirtyLines.Count) path(s):"
    $repo.DirtyLines | Select-Object -First 20 | ForEach-Object { Write-Host "          $_" }
  } else { Write-Info 'changes none (clean working tree)' }
  $stale = @(Get-StaleBuildFiles)
  if ($stale.Count) { Write-Warn "web/ is older than src_web/ for $($stale.Count) file(s), e.g. $($stale[0]). Run make build." }
  else { Write-Ok 'web/ is up to date with src_web/' }

  Write-Step 'Installed custom node'
  Write-Info "path    $InstallDir"
  if (-not (Test-Path -LiteralPath $InstallDir)) { Write-Warn 'not installed at this path' }
  else {
    Write-Info "version $(Get-PyprojectField $InstallDir 'version')"
    $marker = Read-Marker $InstallDir
    if ($marker) {
      Write-Info "source  dev deploy of $($marker.gitCommit) (dirty: $($marker.gitDirty)) at $($marker.deployedAt)"
      Write-Info "backup  $($marker.backupId)"
    } else { Write-Info 'source  not a dev deploy (registry/manual install)' }
    $diff = Compare-HashTables (Get-HashTable $RepoRoot (Get-ManagedRelFiles $RepoRoot)) (Get-HashTable $InstallDir (Get-ManagedRelFiles $InstallDir))
    if ($diff.Count -eq 0) { Write-Ok 'installed files match the repo (deployable set)' }
    else {
      Write-Info "drift   $($diff.Count) file(s) differ between repo and install:"
      Write-DiffSummary $diff 'repo only' 'install only' 15
    }
  }

  Write-Step 'ComfyUI'
  $listening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 8188 })
  if ($listening.Count) { Write-Info 'running: something listens on 127.0.0.1:8188 (ComfyUI default port)' }
  else { Write-Info 'nothing listens on port 8188' }

  Write-Step 'Backups'
  Write-Info "folder  $BackupRoot"
  $list = @(Get-BackupList)
  if (-not $list.Count) { Write-Info 'none yet' }
  foreach ($b in ($list | Select-Object -First 8)) {
    $tag = ''; if (-not $b.Manifest.wasDevDeploy) { $tag = '  [non-dev install]' }
    Write-Info ("{0,-34} v{1,-16} {2,4} files{3}" -f $b.Id, $b.Manifest.version, $b.Manifest.fileCount, $tag)
  }
}

function Invoke-Backups {
  $list = @(Get-BackupList)
  Write-Step "Backups in $BackupRoot"
  if (-not $list.Count) { Write-Info 'none'; return }
  foreach ($b in $list) {
    $valid = if (Test-BackupValid $b) { 'valid' } else { 'INVALID' }
    $tag = ''; if (-not $b.Manifest.wasDevDeploy) { $tag = '  [non-dev install]' }
    Write-Info ("{0,-34} v{1,-16} {2,4} files  {3}{4}" -f $b.Id, $b.Manifest.version, $b.Manifest.fileCount, $valid, $tag)
  }
}

function Invoke-Deploy {
  Write-Step 'Checking source and destination'
  Assert-Source
  Assert-InstallDir -MustExist
  Assert-BackupRootSafe
  Assert-NotSameDirectory
  Write-Info "source       $RepoRoot"
  Write-Info "destination  $InstallDir"
  $stale = @(Get-StaleBuildFiles)
  if ($stale.Count) { Stop-WithError "web/ is stale for $($stale.Count) file(s) (e.g. $($stale[0])). Run: make build" }
  Write-Ok 'source is an rgthree-comfy checkout with an up-to-date build'

  Write-Step 'Comparing files (SHA-256)'
  $srcHashes = Get-HashTable $RepoRoot (Get-ManagedRelFiles $RepoRoot)
  $dstHashes = Get-HashTable $InstallDir (Get-ManagedRelFiles $InstallDir)
  $diff = Compare-HashTables $srcHashes $dstHashes
  if ($diff.Count -eq 0) { Write-Ok 'Installed files already match the repo. Nothing to deploy.'; return }
  Write-Info "$($diff.Added.Count) new, $($diff.Changed.Count) changed, $($diff.Removed.Count) to delete:"
  Write-DiffSummary $diff 'new' 'deleted from install; kept in backup'

  $marker = Read-Marker $InstallDir
  if (-not $marker) {
    Confirm-Typed ("The installed node is not a dev deploy (it is the registry/manual install). Deploying replaces " +
      "its code with your dev build. A verified backup is made first; 'make restore' undoes it.") 'deploy'
  }

  Write-Step 'Backing up the installed node'
  $bk = New-Backup 'pre-deploy'

  Write-Step 'Copying'
  Copy-ManagedFiles $InstallDir

  Write-Step 'Verifying'
  $after = Get-HashTable $InstallDir (Get-ManagedRelFiles $InstallDir)
  $check = Compare-HashTables $srcHashes $after
  if ($check.Count -ne 0) {
    Write-DiffSummary $check 'missing in install' 'unexpected in install'
    Stop-WithError "Deployed files do not match the repo. Restore with: make restore BACKUP=$($bk.Id)"
  }
  Write-Ok "All $($after.Count) deployed files match the repo byte-for-byte"

  $repo = Get-RepoState
  [pscustomobject]@{
    deployedAt = (Get-Date).ToString('o'); source = $RepoRoot; gitBranch = $repo.Branch; gitCommit = $repo.Commit
    gitDirty = $repo.Dirty; backupId = $bk.Id; backupDir = $bk.Dir
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallDir $MarkerName) -Encoding UTF8

  Write-Step 'Done'
  Write-Info "Deployed $($repo.Branch) @ $($repo.Commit.Substring(0, 7))$(if ($repo.Dirty) { ' + uncommitted changes' })"
  Write-Info "Backup of the previous install: $($bk.Dir)"
  Write-Info "Undo: make restore   (restores $($bk.Id))"
  Write-ReloadAdvice (@($diff.Added) + @($diff.Changed) + @($diff.Removed))
}

function Invoke-Restore {
  Assert-InstallDir -MustExist
  Assert-BackupRootSafe
  $list = @(Get-BackupList)
  if (-not $list.Count) { Stop-WithError "No backups in $BackupRoot" }
  if ($Backup -eq 'original') {
    # The install as it was right before a dev deploy replaced it (newest such backup). Fallback:
    # the oldest backup of a non-dev install.
    $pick = $list | Where-Object { $_.Manifest.kind -eq 'pre-deploy' -and -not $_.Manifest.wasDevDeploy } | Select-Object -First 1
    if (-not $pick) { $pick = $list | Where-Object { -not $_.Manifest.wasDevDeploy } | Select-Object -Last 1 }
    if (-not $pick) { Stop-WithError 'No backup of a non-dev install exists.' }
  } elseif ($Backup) {
    $pick = $list | Where-Object { $_.Id -eq $Backup } | Select-Object -First 1
    if (-not $pick) { Stop-WithError "Backup '$Backup' not found. Run: make backups" }
  } else {
    $pick = $list | Where-Object { $_.Manifest.kind -eq 'pre-deploy' } | Select-Object -First 1
    if (-not $pick) { Stop-WithError 'No pre-deploy backup exists. Use BACKUP=<id> (see make backups).' }
  }

  Write-Step "Restoring backup $($pick.Id)"
  Write-Info "kind $($pick.Manifest.kind), version $($pick.Manifest.version), taken $($pick.Manifest.created)"
  if (-not (Test-BackupValid $pick)) { Stop-WithError "Backup $($pick.Id) does not match its manifest; refusing to use it." }
  Write-Ok 'backup verified against its manifest'

  $want = @{}
  foreach ($f in $pick.Manifest.files) { if (-not (Test-UserDataRel $f.path)) { $want[$f.path] = $f.sha256 } }
  $haveFiles = @(Get-RelFiles $InstallDir | Where-Object { -not (Test-UserDataRel $_) })
  $diff = Compare-HashTables $want (Get-HashTable $InstallDir $haveFiles)
  if ($diff.Count -eq 0) { Write-Ok 'The install already matches this backup. Nothing to do.'; return }
  Write-Info "$($diff.Count) file(s) will change:"
  Write-DiffSummary $diff 'restored' 'deleted (not in backup)'
  Write-Info "Kept as-is: $($UserDataNames -join ', ') (user data)."
  Confirm-Typed "Replace the installed node with backup $($pick.Id)? A backup of the current state is made first." 'restore'

  Write-Step 'Backing up the current install first'
  $safety = New-Backup 'pre-restore'

  Write-Step 'Restoring'
  $roboArgs = @($pick.Copy, $InstallDir, '/MIR', '/COPY:DAT', '/DCOPY:T', '/R:1', '/W:1',
    '/XD', '__pycache__', (Join-Path $InstallDir 'userdata'), (Join-Path $pick.Copy 'userdata'),
    '/XF', (Join-Path $InstallDir 'rgthree_config.json'), (Join-Path $pick.Copy 'rgthree_config.json'))
  Invoke-Robocopy $roboArgs | Out-Null

  $after = Get-HashTable $InstallDir @(Get-RelFiles $InstallDir | Where-Object { -not (Test-UserDataRel $_) })
  $check = Compare-HashTables $want $after
  if ($check.Count -ne 0) {
    Write-DiffSummary $check 'missing' 'unexpected'
    Stop-WithError "Restore verification failed. The pre-restore state is in $($safety.Dir)"
  }
  Write-Ok "Installed node now matches backup $($pick.Id) ($($after.Count) files verified)"
  Write-Info "Previous state saved as $($safety.Id)"
  Write-ReloadAdvice (@($diff.Added) + @($diff.Changed) + @($diff.Removed))
}

function Invoke-Upstream {
  Write-Step "Fetching $UpstreamUrl (main)"
  Invoke-RepoGit @('fetch', '--no-tags', $UpstreamUrl, '+refs/heads/main:refs/remotes/upstream/main') | Out-Null
  $up = Invoke-RepoGit @('log', '-1', '--format=%H %cs %s', 'refs/remotes/upstream/main') | Select-Object -First 1
  Write-Ok "upstream/main = $up"
  $counts = (Invoke-RepoGit @('rev-list', '--left-right', '--count', 'HEAD...refs/remotes/upstream/main') | Select-Object -First 1) -split '\s+'
  Write-Info "your branch: $($counts[0]) commit(s) ahead, $($counts[1]) behind upstream/main"
  if ([int]$counts[1] -gt 0) {
    Write-Step 'New upstream commits (newest first, max 20)'
    Invoke-RepoGit @('log', '--oneline', '--no-merges', '-20', 'HEAD..refs/remotes/upstream/main') | ForEach-Object { Write-Host "  $_" }
    $base = Invoke-RepoGit @('merge-base', 'HEAD', 'refs/remotes/upstream/main') | Select-Object -First 1
    $theirs = @(Invoke-RepoGit @('diff', '--name-only', $base, 'refs/remotes/upstream/main'))
    $mine = @(Invoke-RepoGit @('diff', '--name-only', $base)) + @(Invoke-RepoGit @('ls-files', '--others', '--exclude-standard'))
    $overlap = @($theirs | Where-Object { $mine -contains $_ } | Sort-Object -Unique)
    if ($overlap.Count) {
      Write-Warn 'Files changed both upstream and by you (expect merge conflicts here):'
      $overlap | ForEach-Object { Write-Host "  ! $_" }
    } else { Write-Ok 'No file was changed both upstream and by you.' }
    Write-Info 'To bring them in (your decision): git merge upstream/main   (or: git rebase upstream/main)'
  }
  Write-Info "Installed version: $(Get-PyprojectField $InstallDir 'version')   Pinned reset target: $($PinnedUpstreamCommit.Substring(0, 7)) ($PinnedUpstreamLabel)"
}

function Invoke-ResetUpstream {
  Assert-InstallDir -MustExist
  Assert-BackupRootSafe
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Stop-WithError 'git.exe not found (install Git for Windows).' }
  $target = $Ref
  $pinned = $false
  if (-not $target) { $target = $PinnedUpstreamCommit; $pinned = $true }

  Write-Step "Getting upstream source ($UpstreamUrl)"
  if (-not (Test-Path -LiteralPath (Join-Path $UpstreamCache '.git'))) {
    New-Item -ItemType Directory -Path $ToolRoot -Force | Out-Null
    $r = Invoke-Native 'git.exe' @('clone', '--quiet', '--no-checkout', '--filter=blob:none', $UpstreamUrl, $UpstreamCache)
  } else {
    $r = Invoke-Native 'git.exe' @('-C', $UpstreamCache, 'fetch', '--quiet', '--prune', 'origin')
  }
  if ($r.Code -ne 0) {
    Stop-WithError ("Could not reach $UpstreamUrl. Nothing was changed.`n" + ($r.Lines -join "`n"))
  }
  $refName = $target
  if ($target -eq 'main') { $refName = 'origin/main' }
  $r = Invoke-Native 'git.exe' @('-C', $UpstreamCache, 'rev-parse', '--verify', '--quiet', "$refName^{commit}")
  $hash = $r.Lines | Select-Object -First 1
  if ($r.Code -ne 0 -or -not $hash) { Stop-WithError "'$target' is not a commit in $UpstreamUrl. Nothing was changed." }
  $r = Invoke-Native 'git.exe' @('-C', $UpstreamCache, 'merge-base', '--is-ancestor', $hash, 'origin/main')
  if ($r.Code -ne 0) { Stop-WithError "$hash is not part of upstream main's history. Refusing. Nothing was changed." }
  $info = (Invoke-Native 'git.exe' @('-C', $UpstreamCache, 'log', '-1', '--format=%cs %s', $hash)).Lines | Select-Object -First 1
  if ($pinned) { $what = "PINNED commit $hash = $PinnedUpstreamLabel" }
  elseif ($target -eq 'main') { $what = "LATEST upstream main, resolved now to $hash" }
  else { $what = "requested commit $hash" }
  Write-Ok "verified: $what"
  Write-Info "commit date/subject: $info"

  Write-Step 'Exporting that commit to a temporary folder'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $work = Join-Path $TempRoot "upstream-$($hash.Substring(0, 7))-$stamp"
  $zip = "$work.zip"
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  try {
    # autocrlf/eol off: export the exact bytes stored in git (Git for Windows defaults to CRLF).
    $r = Invoke-Native 'git.exe' @('-C', $UpstreamCache, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=zip', '-o', $zip, $hash)
    if ($r.Code -ne 0) { Stop-WithError ("git archive failed. Nothing was changed.`n" + ($r.Lines -join "`n")) }
    Expand-Archive -LiteralPath $zip -DestinationPath $work -Force
    $expected = (Invoke-Native 'git.exe' @('-C', $UpstreamCache, 'ls-tree', '-r', '--name-only', $hash)).Lines.Count
    $got = @(Get-RelFiles $work).Count
    if ($got -ne $expected) { Stop-WithError "Export has $got files, git says $expected. Nothing was changed." }
    Write-Ok "$got files exported"

    $want = Get-HashTable $work (Get-RelFiles $work)
    $haveFiles = @(Get-RelFiles $InstallDir | Where-Object { -not (Test-UserDataRel $_) -and $_ -ne '.tracking' })
    $diff = Compare-HashTables $want (Get-HashTable $InstallDir $haveFiles)
    if ($diff.Count -eq 0) { Write-Ok 'The install already matches this upstream commit. Nothing to do.'; return }
    Write-Info "$($diff.Count) file(s) will change:"
    Write-DiffSummary $diff 'from upstream' 'deleted (not in upstream)'
    Write-Info "Kept as-is: $($UserDataNames -join ', '), .tracking. Your dev repo is not touched."
    Confirm-Typed "Replace the installed node with upstream $($hash.Substring(0, 7))? A backup is made first." $hash.Substring(0, 7)

    Write-Step 'Backing up the current install first'
    $bk = New-Backup 'pre-reset-upstream'

    Write-Step 'Replacing installed files'
    $roboArgs = @($work, $InstallDir, '/MIR', '/COPY:DAT', '/DCOPY:T', '/R:1', '/W:1',
      '/XD', '__pycache__', (Join-Path $InstallDir 'userdata'),
      '/XF', (Join-Path $InstallDir 'rgthree_config.json'), (Join-Path $InstallDir '.tracking'))
    Invoke-Robocopy $roboArgs | Out-Null
    $after = Get-HashTable $InstallDir @(Get-RelFiles $InstallDir | Where-Object { -not (Test-UserDataRel $_) -and $_ -ne '.tracking' })
    $check = Compare-HashTables $want $after
    if ($check.Count -ne 0) {
      Write-DiffSummary $check 'missing' 'unexpected'
      Stop-WithError "Verification failed. Previous state: $($bk.Dir)"
    }
    Write-Ok "Installed node now equals upstream $hash ($($after.Count) files verified)"
    Write-Info "Previous state saved as $($bk.Id)  (undo: make restore BACKUP=$($bk.Id))"
    Write-ReloadAdvice (@($diff.Added) + @($diff.Changed) + @($diff.Removed))
  } finally {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Get-ComfyRoot {
  # <ComfyUI>\custom_nodes\rgthree-comfy -> <ComfyUI>
  return Split-Path -Parent (Split-Path -Parent (Get-NormalPath $InstallDir))
}

function Test-PortListening([int] $Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

# A tiny valid .safetensors file (8-byte header length + JSON header), so the LoRA chooser has entries.
function New-SampleLora([string] $Path) {
  if (Test-Path -LiteralPath $Path) { return }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
  $json = '{"__metadata__":{"note":"rgthree sandbox sample, not a real LoRA"}}'
  while ($json.Length % 8) { $json += ' ' }
  $header = [Text.Encoding]::ASCII.GetBytes($json)
  $bytes = [BitConverter]::GetBytes([uint64]$header.Length) + $header
  [IO.File]::WriteAllBytes($Path, [byte[]]$bytes)
}

function Invoke-Sandbox {
  Assert-Source
  $stale = @(Get-StaleBuildFiles)
  if ($stale.Count) { Stop-WithError "web/ is stale for $($stale.Count) file(s). Run: make build" }
  $comfyRoot = Get-ComfyRoot
  $python = $env:RGTHREE_COMFY_PYTHON
  if (-not $python) { $python = Join-Path $comfyRoot '.venv\Scripts\python.exe' }
  $main = Join-Path $comfyRoot 'main.py'
  if (-not (Test-Path -LiteralPath $main)) { Stop-WithError "ComfyUI main.py not found at $main" }
  if (-not (Test-Path -LiteralPath $python)) { Stop-WithError "Python not found: $python (set RGTHREE_COMFY_PYTHON)" }

  Write-Step "Sandbox: $SandboxDir"
  foreach ($d in @('custom_nodes', 'user\default', 'input', 'output', 'temp')) {
    New-Item -ItemType Directory -Path (Join-Path $SandboxDir $d) -Force | Out-Null
  }
  Copy-ManagedFiles (Join-Path $SandboxDir 'custom_nodes\rgthree-comfy')
  Write-Ok 'dev build copied into the sandbox (your real install is not touched)'
  foreach ($name in @('sandbox_anime.safetensors', 'sandbox_detail.safetensors', 'styles\sandbox_style.safetensors')) {
    New-SampleLora (Join-Path $SandboxDir "models\loras\$name")
  }
  $settings = Join-Path $SandboxDir 'user\default\comfy.settings.json'
  if (-not (Test-Path -LiteralPath $settings)) {
    # Start in Nodes 2.0 (like your real install); no first-run tutorial; no "leave page?" prompt.
    Set-Content -LiteralPath $settings -Encoding ASCII -Value ('{"Comfy.VueNodes.Enabled": true, "Comfy.TutorialCompleted": true, ' +
      '"Comfy.Window.UnloadConfirmation": false, "Comfy.Workflow.ShowMissingModelsWarning": false}')
  }

  $url = "http://127.0.0.1:$SandboxPort"
  if (Test-PortListening $SandboxPort) {
    Write-Ok "Sandbox ComfyUI already running at $url"
    Write-Info 'Web changes: reload that page. Python changes: close the sandbox window and run make sandbox again.'
    return
  }
  $env:PYTHONIOENCODING = 'utf-8'  # its log has emoji; a non-UTF-8 console would crash it
  Start-Process -FilePath $python -WorkingDirectory $comfyRoot -ArgumentList @(
    "`"$main`"", '--base-directory', "`"$SandboxDir`"", '--port', "$SandboxPort", '--listen', '127.0.0.1',
    '--cpu', '--disable-auto-launch', '--database-url', 'sqlite:///:memory:') | Out-Null
  Write-Info 'Starting a separate ComfyUI in its own window (CPU only, in-memory database)...'
  for ($i = 0; $i -lt 90 -and -not (Test-PortListening $SandboxPort); $i++) { Start-Sleep -Seconds 1 }
  if (-not (Test-PortListening $SandboxPort)) { Stop-WithError 'The sandbox did not start within 90 s; check its window for errors.' }
  Write-Ok "Sandbox ComfyUI is up: $url   (close its window to stop it)"
}

function Invoke-E2E {
  $url = "http://127.0.0.1:$SandboxPort"
  if (-not (Test-PortListening $SandboxPort)) { Stop-WithError "No sandbox at $url. Run: make sandbox" }
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Stop-WithError 'node.exe (Windows Node 22+) not found.' }
  $out = Join-Path $ToolRoot 'e2e-out'
  Write-Step "Browser tests against $url (headless Edge; about 1-2 minutes)"
  Write-Info "Live progress: $out\progress.log"
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & node.exe (Join-Path $RepoRoot 'tests\e2e\power_lora_loader.e2e.mjs') --url $url --out $out 2>&1 | ForEach-Object { Write-Host (ConvertTo-Line $_) } }
  finally { $ErrorActionPreference = $old }
  if ($LASTEXITCODE -ne 0) { Stop-WithError "browser tests failed (details: $out\results.json)" }
  Write-Ok "Screenshots and results: $out"
}

function Invoke-Clean {
  Write-Step 'Removing generated dev artifacts'
  $targets = @()
  foreach ($rel in @('web\comfyui\tests', 'web\comfyui\testing', 'web\scripts_comfy', '.pytest_cache')) {
    $p = Join-Path $RepoRoot $rel
    if (Test-Path -LiteralPath $p) { $targets += $p }
  }
  foreach ($d in Get-ChildItem -LiteralPath $RepoRoot -Recurse -Directory -Force -Filter '__pycache__' -ErrorAction SilentlyContinue) {
    if ($d.FullName -notmatch '\\node_modules\\') { $targets += $d.FullName }
  }
  if (Test-Path -LiteralPath $TempRoot) { $targets += $TempRoot }
  if (-not $targets.Count) { Write-Ok 'Nothing to clean.'; return }
  foreach ($t in $targets) {
    Remove-Item -LiteralPath $t -Recurse -Force
    Write-Info "removed $t"
  }
  Write-Ok "Removed $($targets.Count) item(s). Not touched: node_modules, backups, upstream cache, your sources."
}

function Invoke-PsSyntaxCheck {
  Write-Host ''
  Write-Host '== PowerShell syntax check (scripts\*.ps1)' -ForegroundColor Cyan
  $bad = 0
  foreach ($f in Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'scripts') -Filter *.ps1) {
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { $bad++; $errors | ForEach-Object { Write-Host "  $($f.Name):$($_.Extent.StartLineNumber) $($_.Message)" -ForegroundColor Red } }
  }
  if ($bad) { return 1 }
  Write-Host 'OK: scripts parse'
  return 0
}

switch ($Command.ToLowerInvariant()) {
  'help' { Show-Help }
  'setup' { exit (Invoke-RepoTask 'setup') }
  'status' { Invoke-Status }
  'check' {
    $code = Invoke-RepoTask 'check'
    $ps = Invoke-PsSyntaxCheck
    if ($code -ne 0 -or $ps -ne 0) { Stop-WithError 'check failed' }
  }
  'build' { $code = Invoke-RepoTask 'build'; if ($code -ne 0) { Stop-WithError "build failed (exit $code)" } }
  'deploy' { Invoke-Deploy }
  'backup' { Write-Step 'Manual backup'; New-Backup 'manual' | Out-Null }
  'backups' { Invoke-Backups }
  'restore' { Invoke-Restore }
  'upstream' { Invoke-Upstream }
  'reset-upstream' { Invoke-ResetUpstream }
  'sandbox' { Invoke-Sandbox }
  'e2e' { Invoke-E2E }
  'clean' { Invoke-Clean }
  default { Write-Host "Unknown command '$Command'." -ForegroundColor Red; Show-Help; exit 2 }
}
