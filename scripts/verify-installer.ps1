[CmdletBinding()]
param(
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = (Resolve-Path (Join-Path $projectRoot 'release')).Path

if (-not $InstallerPath) {
  $candidate = Get-ChildItem -LiteralPath $releaseRoot -Filter '*-setup.exe' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $candidate) { throw 'Installer EXE was not found.' }
  $InstallerPath = $candidate.FullName
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$installRoot = Join-Path $releaseRoot ('smoke-install-' + [guid]::NewGuid().ToString('N'))
$testData = Join-Path ([IO.Path]::GetTempPath()) ('SkyForce-Installer-Smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testData | Out-Null

try {
  $setup = Start-Process -FilePath $resolvedInstaller `
    -ArgumentList @('/S', ('/D=' + $installRoot)) `
    -PassThru
  if (-not $setup.WaitForExit(60000)) {
    Stop-Process -Id $setup.Id -Force
    throw 'Installer timed out.'
  }
  if ($setup.ExitCode -ne 0) { throw "Installer exit code: $($setup.ExitCode)" }

  $installedExe = Join-Path $installRoot 'SkyForce.exe'
  if (-not (Test-Path -LiteralPath $installedExe)) { throw 'Installed EXE is missing.' }

  $appProcess = Start-Process -FilePath $installedExe `
    -ArgumentList @(('--user-data-dir=' + $testData), '--smoke-test') `
    -PassThru
  if (-not $appProcess.WaitForExit(30000)) {
    Stop-Process -Id $appProcess.Id -Force
    throw 'Installed application smoke test timed out.'
  }
  if ($appProcess.ExitCode -ne 0) { throw "Application exit code: $($appProcess.ExitCode)" }

  $uninstaller = Join-Path $installRoot 'Uninstall SkyForce.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Uninstaller is missing.' }
  $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
  if (-not $uninstallProcess.WaitForExit(60000)) {
    Stop-Process -Id $uninstallProcess.Id -Force
    throw 'Uninstaller timed out.'
  }
  if ($uninstallProcess.ExitCode -ne 0) {
    throw "Uninstaller exit code: $($uninstallProcess.ExitCode)"
  }

  [pscustomobject]@{
    Installer = $resolvedInstaller
    InstalledApplicationStarted = $true
    UninstallerExitCode = $uninstallProcess.ExitCode
    Result = 'PASS'
  } | Format-List
}
finally {
  Start-Sleep -Milliseconds 800
  $releaseFull = [IO.Path]::GetFullPath($releaseRoot).TrimEnd('\')
  $installFull = [IO.Path]::GetFullPath($installRoot).TrimEnd('\')
  if (
    (Test-Path -LiteralPath $installFull) -and
    $installFull.StartsWith($releaseFull + '\smoke-install-', [StringComparison]::OrdinalIgnoreCase)
  ) {
    Remove-Item -LiteralPath $installFull -Recurse -Force -ErrorAction SilentlyContinue
  }

  $tempFull = [IO.Path]::GetFullPath($testData).TrimEnd('\')
  $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if (
    (Test-Path -LiteralPath $tempFull) -and
    $tempFull.StartsWith($systemTemp + '\SkyForce-Installer-Smoke-', [StringComparison]::OrdinalIgnoreCase)
  ) {
    Remove-Item -LiteralPath $tempFull -Recurse -Force -ErrorAction SilentlyContinue
  }
}
