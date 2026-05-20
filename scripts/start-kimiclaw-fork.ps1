<#
.SYNOPSIS
    Launch the kimiclaw-provider fork of nimbalyst in an ISOLATED instance
    that runs side-by-side with vanilla nimbalyst without conflict.

.DESCRIPTION
    The conflict between the kimiclaw fork and vanilla nimbalyst is that
    both default to the same userData directory
    (%APPDATA%\@nimbalyst\electron): same PGLite database (lock fight),
    same sessions, same settings, same control-plane discovery files.

    nimbalyst already supports running multiple instances — index.ts:504
    sets `allowMultipleInstances = !!process.env.NIMBALYST_USER_DATA_DIR`,
    so giving the fork its own userData dir BOTH isolates its state AND
    skips the single-instance lock. This script sets that env var to a
    dedicated `electron-kimiclaw` directory, then launches the fork's
    built instance.

    Result:
      - vanilla nimbalyst   → %APPDATA%\@nimbalyst\electron       (untouched)
      - kimiclaw fork       → %APPDATA%\@nimbalyst\electron-kimiclaw
      - separate PGLite DBs, no lock contention
      - MCP/control HTTP ports auto fall-forward (vanilla 3456, fork 3457+)
      - fork writes .control-token/.control-port into ITS userData so the
        nimbalyst-mcp sidecar (pointed at the same dir) drives the FORK.

.PARAMETER UserDataDir
    Override the isolated userData path. Default
    %APPDATA%\@nimbalyst\electron-kimiclaw.

.PARAMETER Build
    Run a fresh electron-vite build before launching. Default: use the
    existing out/ build (faster). Pass -Build after pulling new fork code.

.EXAMPLE
    pwsh scripts/start-kimiclaw-fork.ps1
    pwsh scripts/start-kimiclaw-fork.ps1 -Build
#>
param(
    [string]$UserDataDir = (Join-Path $env:APPDATA '@nimbalyst\electron-kimiclaw'),
    [switch]$Build
)

$ErrorActionPreference = 'Stop'

# Repo root = parent of this script's dir (scripts/ lives at repo root).
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$electronPkg = Join-Path $repoRoot 'packages\electron'

if (-not (Test-Path $electronPkg)) {
    Write-Error "packages/electron not found under $repoRoot — run from the fork checkout."
    exit 1
}

# Isolate this instance. Setting NIMBALYST_USER_DATA_DIR:
#   1. flips allowMultipleInstances=true (skips single-instance lock)
#   2. relocates PGLite DB + sessions + settings + control discovery files
$env:NIMBALYST_USER_DATA_DIR = $UserDataDir
New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null

Write-Host "=== KimiClaw fork — isolated instance ===" -ForegroundColor Cyan
Write-Host "  repo:     $repoRoot" -ForegroundColor DarkGray
Write-Host "  userData: $UserDataDir" -ForegroundColor Green
Write-Host "  vanilla untouched at: $(Join-Path $env:APPDATA '@nimbalyst\electron')" -ForegroundColor DarkGray
Write-Host ""

Set-Location $electronPkg

if ($Build) {
    Write-Host "Building (electron-vite)..." -ForegroundColor Yellow
    # Bypass the npx segfault seen on this box — call the bin directly.
    & node ..\..\node_modules\electron-vite\bin\electron-vite.js build
    if ($LASTEXITCODE -ne 0) { Write-Error "build failed"; exit 1 }
}

Write-Host "Launching fork instance (electron-vite preview)..." -ForegroundColor Green
Write-Host "  This window stays attached; close it or Ctrl+C to stop the fork." -ForegroundColor DarkGray
Write-Host "  Vanilla nimbalyst keeps running independently." -ForegroundColor DarkGray
Write-Host ""

# electron-vite preview launches electron against the built out/ dir.
# NIMBALYST_USER_DATA_DIR is inherited by the child electron process.
& npm run start
