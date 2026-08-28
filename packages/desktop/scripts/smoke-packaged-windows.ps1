param(
  [string]$AppDirectory = (Join-Path $PSScriptRoot "..\dist\win-unpacked"),
  [string]$MarkerPath = "",
  [ValidateRange(1, 300)]
  [int]$ReadyTimeoutSeconds = 90,
  [ValidateRange(1, 120)]
  [int]$ExitTimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$appDirectoryPath = [System.IO.Path]::GetFullPath($AppDirectory)
if (!(Test-Path -LiteralPath $appDirectoryPath -PathType Container)) {
  throw "Packaged desktop directory does not exist: $appDirectoryPath"
}

$apps = @(
  Get-ChildItem -LiteralPath $appDirectoryPath -Filter "*.exe" -File |
    Where-Object { $_.Name -notmatch "mongolgpt-cli" }
)
if ($apps.Count -ne 1) {
  throw "Expected one packaged desktop executable, found $($apps.Count)."
}

if ([string]::IsNullOrWhiteSpace($MarkerPath)) {
  $markerRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
  $MarkerPath = Join-Path $markerRoot "mongolgpt-desktop-smoke.json"
}
$marker = [System.IO.Path]::GetFullPath($MarkerPath)
$stdout = "$marker.stdout.log"
$stderr = "$marker.stderr.log"

$previousOnboarding = [Environment]::GetEnvironmentVariable("MONGOLGPT_TEST_ONBOARDING", "Process")
$previousMarker = [Environment]::GetEnvironmentVariable("MONGOLGPT_DESKTOP_SMOKE_FILE", "Process")
$process = $null
$summary = $null
$failure = $null

Remove-Item -LiteralPath $marker, $stdout, $stderr -Force -ErrorAction SilentlyContinue
[Environment]::SetEnvironmentVariable("MONGOLGPT_TEST_ONBOARDING", "1", "Process")
[Environment]::SetEnvironmentVariable("MONGOLGPT_DESKTOP_SMOKE_FILE", $marker, "Process")

try {
  $process = Start-Process `
    -FilePath $apps[0].FullName `
    -ArgumentList "--enable-logging=stderr" `
    -WorkingDirectory $apps[0].DirectoryName `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr

  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
  while (!(Test-Path -LiteralPath $marker) -and (Get-Date) -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) {
      throw "Packaged desktop exited before reporting ready (code $($process.ExitCode))."
    }
    Start-Sleep -Milliseconds 500
  }

  if (!(Test-Path -LiteralPath $marker)) {
    throw "Packaged desktop did not report ready within $ReadyTimeoutSeconds seconds."
  }

  $rawResult = Get-Content -Raw -LiteralPath $marker
  $result = $rawResult | ConvertFrom-Json
  if ($result.status -ne "ready" -or $result.url -notlike "mongolgpt-renderer://renderer/*") {
    throw "Packaged desktop returned an invalid smoke result: $rawResult"
  }

  if (!$process.WaitForExit($ExitTimeoutSeconds * 1000)) {
    throw "Packaged desktop reported ready but did not exit cleanly."
  }
  if ($process.ExitCode -ne 0) {
    throw "Packaged desktop exited with code $($process.ExitCode)."
  }

  $summary = [PSCustomObject]@{
    executable = $apps[0].FullName
    status = $result.status
    url = $result.url
    version = $result.version
    exitCode = $process.ExitCode
  }
} catch {
  $failure = $_
} finally {
  if ($null -ne $process) {
    $process.Refresh()
    if (!$process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
  [Environment]::SetEnvironmentVariable("MONGOLGPT_TEST_ONBOARDING", $previousOnboarding, "Process")
  [Environment]::SetEnvironmentVariable("MONGOLGPT_DESKTOP_SMOKE_FILE", $previousMarker, "Process")
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}

if ($null -ne $failure) {
  $diagnostics = @(
    @($stderr, $stdout) |
      Where-Object { Test-Path -LiteralPath $_ } |
      ForEach-Object {
        $tail = Get-Content -LiteralPath $_ -Tail 80 -ErrorAction SilentlyContinue
        if ($tail) { "--- $_ ---`n$($tail -join "`n")" }
      }
  )
  Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  $suffix = if ($diagnostics.Count) { "`n$($diagnostics -join "`n")" } else { "" }
  throw "$($failure.Exception.Message)$suffix"
}

Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
$summary
