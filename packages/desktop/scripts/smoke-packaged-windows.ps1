param(
  [string]$AppDirectory = (Join-Path $PSScriptRoot "..\dist\win-unpacked"),
  [string]$MarkerPath = "",
  [string]$ExpectedVersion = "",
  [string]$ExpectedProductName = "",
  [switch]$UseExternalPtyProbe,
  [ValidateRange(1, 300)]
  [int]$ReadyTimeoutSeconds = 90,
  [ValidateRange(1, 120)]
  [int]$ExitTimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-DesktopSmokeScreenshot {
  param([string]$Path, [object]$Metadata)

  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Packaged desktop screenshot үүссэнгүй: $Path"
  }
  $file = Get-Item -LiteralPath $Path
  if ($Metadata.width -lt 1 -or $Metadata.height -lt 1 -or $Metadata.bytes -ne $file.Length) {
    throw "Packaged desktop screenshot metadata буруу байна: $($Metadata | ConvertTo-Json -Compress)"
  }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $expected = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)
  if ($bytes.Length -lt $expected.Length) {
    throw "Packaged desktop screenshot хоосон байна: $Path"
  }
  for ($index = 0; $index -lt $expected.Length; $index++) {
    if ($bytes[$index] -ne $expected[$index]) {
      throw "Packaged desktop screenshot PNG файл биш байна: $Path"
    }
  }
  return [PSCustomObject]@{
    path = $Path
    width = $Metadata.width
    height = $Metadata.height
    bytes = $file.Length
  }
}

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

$installer = Join-Path $PSScriptRoot "..\dist\mongolgpt-desktop-win-x64.exe"
& (Join-Path $PSScriptRoot "verify-branding-windows.ps1") `
  -AppDirectory $appDirectoryPath `
  -ExpectedProductName $ExpectedProductName `
  -InstallerPath $installer | Out-Null

if ([string]::IsNullOrWhiteSpace($MarkerPath)) {
  $markerRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
  $MarkerPath = Join-Path $markerRoot "mongolgpt-desktop-smoke.json"
}
$marker = [System.IO.Path]::GetFullPath($MarkerPath)
$stdout = "$marker.stdout.log"
$stderr = "$marker.stderr.log"
$externalPtyProof = "$marker.pty-proof"
$screenshotPath = "$marker.png"

$previousOnboarding = [Environment]::GetEnvironmentVariable("MONGOLGPT_TEST_ONBOARDING", "Process")
$previousMarker = [Environment]::GetEnvironmentVariable("MONGOLGPT_DESKTOP_SMOKE_FILE", "Process")
$previousConptyDll = [Environment]::GetEnvironmentVariable("MONGOLGPT_PTY_USE_CONPTY_DLL", "Process")
$previousExternalPtyProof = [Environment]::GetEnvironmentVariable(
  "MONGOLGPT_DESKTOP_SMOKE_EXTERNAL_PTY_PROOF",
  "Process"
)
$previousRunAsNode = [Environment]::GetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "Process")
$process = $null
$summary = $null
$failure = $null

Remove-Item -LiteralPath $marker, $stdout, $stderr, $externalPtyProof, $screenshotPath -Force -ErrorAction SilentlyContinue
[Environment]::SetEnvironmentVariable("MONGOLGPT_TEST_ONBOARDING", "1", "Process")
[Environment]::SetEnvironmentVariable("MONGOLGPT_DESKTOP_SMOKE_FILE", $marker, "Process")
[Environment]::SetEnvironmentVariable("MONGOLGPT_PTY_USE_CONPTY_DLL", "1", "Process")
[Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", $null, "Process")

try {
  if ($UseExternalPtyProbe) {
    & (Join-Path $PSScriptRoot "smoke-packaged-pty-windows.ps1") `
      -ExecutablePath $apps[0].FullName `
      -ProofPath $externalPtyProof | Out-Null
    [Environment]::SetEnvironmentVariable(
      "MONGOLGPT_DESKTOP_SMOKE_EXTERNAL_PTY_PROOF",
      $externalPtyProof,
      "Process"
    )
  }

  $process = Start-Process `
    -FilePath $apps[0].FullName `
    -ArgumentList "--enable-logging=stderr" `
    -Environment @{ ELECTRON_RUN_AS_NODE = $null } `
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
  if ($result.status -eq "error") {
    throw "Packaged desktop smoke failed: $($result.error)"
  }
  if ($result.status -ne "ready" -or $result.url -notlike "mongolgpt-renderer://renderer/*") {
    throw "Packaged desktop returned an invalid smoke result: $rawResult"
  }
  if (
    $result.language -ne "mn" -or
    $result.onboardingStage -ne "account" -or
    $result.accountGateVisible -ne $true -or
    $result.accountLogo -ne "mongolgpt" -or
    $result.accountHeading -ne "MongolGPT бүртгэлээрээ нэвтэрнэ үү" -or
    $result.loginAction -ne "Бүртгүүлэх эсвэл нэвтрэх"
  ) {
    throw "Packaged desktop did not show the Mongolian MongolGPT account gate: $rawResult"
  }
  $screenshot = Assert-DesktopSmokeScreenshot -Path $screenshotPath -Metadata $result.screenshot
  $functionalHttp = @($result.functional.summary.http.PSObject.Properties.Value)
  if (
    $result.functional.capable -ne $true -or
    $functionalHttp.Count -ne 15 -or
    @($functionalHttp | Where-Object { $_.ok -ne $true }).Count -ne 0 -or
    $result.functional.summary.terminal.ok -ne $true -or
    $result.functional.summary.fixture.skill -ne $true -or
    $result.functional.summary.fixture.tool -ne $true -or
    $result.functional.summary.fixture.config -ne $true -or
    $result.functional.summary.fixture.mcpConfiguredDisabled -ne $true -or
    $result.functional.summary.fixture.localModelInference -ne $true
  ) {
    throw "Packaged desktop functional smoke failed: $rawResult"
  }
  if (![string]::IsNullOrWhiteSpace($ExpectedVersion) -and $result.version -ne $ExpectedVersion) {
    throw "Packaged desktop version is $($result.version); expected $ExpectedVersion."
  }

  $versionInfo = $apps[0].VersionInfo
  if (![string]::IsNullOrWhiteSpace($ExpectedProductName) -and $versionInfo.ProductName -ne $ExpectedProductName) {
    throw "Packaged desktop product name is $($versionInfo.ProductName); expected $ExpectedProductName."
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
    productName = $versionInfo.ProductName
    language = $result.language
    onboardingStage = $result.onboardingStage
    accountGateVisible = $result.accountGateVisible
    accountLogo = $result.accountLogo
    accountHeading = $result.accountHeading
    loginAction = $result.loginAction
    screenshot = $screenshot
    functional = $result.functional
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
  [Environment]::SetEnvironmentVariable("MONGOLGPT_PTY_USE_CONPTY_DLL", $previousConptyDll, "Process")
  [Environment]::SetEnvironmentVariable(
    "MONGOLGPT_DESKTOP_SMOKE_EXTERNAL_PTY_PROOF",
    $previousExternalPtyProof,
    "Process"
  )
  [Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", $previousRunAsNode, "Process")
  Remove-Item -LiteralPath $marker, $externalPtyProof -Force -ErrorAction SilentlyContinue
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
