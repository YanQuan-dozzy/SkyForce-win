[CmdletBinding()]
param(
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found. The build machine requires Node.js 24.x.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'npm was not found.'
}

$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

if (-not $SkipInstall) {
  npm ci --cache (Join-Path $projectRoot '.npm-cache')
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
}

npm run dist:win
if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'Build artifacts:'
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'release') -File |
  Where-Object Extension -in '.exe', '.yml', '.blockmap' |
  Select-Object Name, Length, LastWriteTime |
  Format-Table -AutoSize
