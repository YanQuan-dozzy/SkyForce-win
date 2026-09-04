[CmdletBinding()]
param(
  [string]$ExecutablePath
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path $projectRoot 'release'

if (-not $ExecutablePath) {
  $portable = Get-ChildItem -LiteralPath $releaseRoot -Filter '*-portable.exe' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $portable) { throw 'Portable EXE was not found in the release directory.' }
  $ExecutablePath = $portable.FullName
}

$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
if ([IO.Path]::GetExtension($resolvedExecutable) -ne '.exe') {
  throw 'The verification target must be an EXE file.'
}

$testDataRoot = Join-Path ([IO.Path]::GetTempPath()) ('SkyForce-Smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDataRoot | Out-Null

try {
  $process = Start-Process -FilePath $resolvedExecutable `
    -ArgumentList @("--user-data-dir=$testDataRoot", '--smoke-test') `
    -PassThru

  if (-not $process.WaitForExit(30000)) {
    Stop-Process -Id $process.Id -Force
    throw 'The application did not finish its smoke test in 30 seconds.'
  }
  if ($process.ExitCode -ne 0) {
    throw "Unexpected smoke test exit code: $($process.ExitCode)"
  }

  $database = Join-Path $testDataRoot 'data\skyforce.db'
  $logFile = Join-Path $testDataRoot 'logs\skyforce.log'
  if (-not (Test-Path -LiteralPath $database)) { throw 'The smoke test did not initialize SQLite.' }
  if (-not (Test-Path -LiteralPath $logFile)) { throw 'The smoke test did not initialize logging.' }
  if (-not (Select-String -LiteralPath $logFile -SimpleMatch 'Packaged smoke test passed' -Quiet)) {
    throw 'The smoke-test success marker is missing from the log.'
  }

  $hash = Get-FileHash -LiteralPath $resolvedExecutable -Algorithm SHA256
  [pscustomobject]@{
    Executable = $resolvedExecutable
    SizeBytes = (Get-Item -LiteralPath $resolvedExecutable).Length
    SHA256 = $hash.Hash
    DatabaseInitialized = $true
    LogInitialized = $true
    Result = 'PASS'
  } | Format-List
}
finally {
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  $resolvedTestRoot = [IO.Path]::GetFullPath($testDataRoot).TrimEnd('\')
  if ($resolvedTestRoot.StartsWith($tempRoot + '\SkyForce-Smoke-', [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
