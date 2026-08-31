param(
  [string]$InstallerPath = (Join-Path $PSScriptRoot "..\dist\mongolgpt-desktop-win-x64.exe"),
  [string]$MarkerPath = "",
  [string]$ExpectedVersion = "",
  [string]$ExpectedProductName = "",
  [switch]$UseExternalPtyProbe,
  [ValidateRange(1, 300)]
  [int]$InstallTimeoutSeconds = 180,
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
    throw "Installed desktop screenshot үүссэнгүй: $Path"
  }
  $file = Get-Item -LiteralPath $Path
  if ($Metadata.width -lt 1 -or $Metadata.height -lt 1 -or $Metadata.bytes -ne $file.Length) {
    throw "Installed desktop screenshot metadata буруу байна: $($Metadata | ConvertTo-Json -Compress)"
  }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $expected = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)
  if ($bytes.Length -lt $expected.Length) {
    throw "Installed desktop screenshot хоосон байна: $Path"
  }
  for ($index = 0; $index -lt $expected.Length; $index++) {
    if ($bytes[$index] -ne $expected[$index]) {
      throw "Installed desktop screenshot PNG файл биш байна: $Path"
    }
  }
  return [PSCustomObject]@{
    path = $Path
    width = $Metadata.width
    height = $Metadata.height
    bytes = $file.Length
  }
}

function New-SmokeMarkerPath {
  param([string]$Candidate)

  if (![string]::IsNullOrWhiteSpace($Candidate)) {
    return [System.IO.Path]::GetFullPath($Candidate)
  }

  $markerRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
  return Join-Path $markerRoot "mongolgpt-desktop-installed-smoke.json"
}

function Find-InstalledDesktopExecutable {
  param([string]$Root)

  $apps = @(
    Get-ChildItem -LiteralPath $Root -Recurse -Filter "*.exe" -File |
      Where-Object {
        $_.Name -notmatch "^uninstall " -and
        $_.Name -notmatch "unins.*\.exe$" -and
        $_.Name -notmatch "mongolgpt-cli" -and
        $_.Name -notmatch "^elevate\.exe$" -and
        $_.Name -notmatch "^OpenConsole\.exe$"
      }
  )

  if ($apps.Count -ne 1) {
    $names = ($apps | ForEach-Object { $_.FullName }) -join ", "
    throw "Installed desktop executable count mismatch ($($apps.Count)): $names"
  }

  return $apps[0]
}

function Invoke-DesktopSmoke {
  param(
    [System.IO.FileInfo]$Executable,
    [string]$Marker,
    [string]$ExpectedVersionValue,
    [string]$ExpectedProductNameValue,
    [bool]$ExternalPtyProbe,
    [int]$ReadyTimeout,
    [int]$ExitTimeout
  )

  $stdout = "$Marker.stdout.log"
  $stderr = "$Marker.stderr.log"
  $externalPtyProof = "$Marker.pty-proof"
  $screenshotPath = "$Marker.png"
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

  Remove-Item -LiteralPath $Marker, $stdout, $stderr, $externalPtyProof, $screenshotPath -Force -ErrorAction SilentlyContinue
  [Environment]::SetEnvironmentVariable("MONGOLGPT_TEST_ONBOARDING", "1", "Process")
  [Environment]::SetEnvironmentVariable("MONGOLGPT_DESKTOP_SMOKE_FILE", $Marker, "Process")
  [Environment]::SetEnvironmentVariable("MONGOLGPT_PTY_USE_CONPTY_DLL", "1", "Process")
  [Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", $null, "Process")

  try {
    if ($ExternalPtyProbe) {
      & (Join-Path $PSScriptRoot "smoke-packaged-pty-windows.ps1") `
        -ExecutablePath $Executable.FullName `
        -ProofPath $externalPtyProof | Out-Null
      [Environment]::SetEnvironmentVariable(
        "MONGOLGPT_DESKTOP_SMOKE_EXTERNAL_PTY_PROOF",
        $externalPtyProof,
        "Process"
      )
    }

    $process = Start-Process `
      -FilePath $Executable.FullName `
      -ArgumentList "--enable-logging=stderr" `
      -Environment @{ ELECTRON_RUN_AS_NODE = $null } `
      -WorkingDirectory $Executable.DirectoryName `
      -PassThru `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr

    $deadline = (Get-Date).AddSeconds($ReadyTimeout)
    while (!(Test-Path -LiteralPath $Marker) -and (Get-Date) -lt $deadline) {
      $process.Refresh()
      if ($process.HasExited) {
        throw "Installed desktop exited before reporting ready (code $($process.ExitCode))."
      }
      Start-Sleep -Milliseconds 500
    }

    if (!(Test-Path -LiteralPath $Marker)) {
      throw "Installed desktop did not report ready within $ReadyTimeout seconds."
    }

    $rawResult = Get-Content -Raw -LiteralPath $Marker
    $result = $rawResult | ConvertFrom-Json
    if ($result.status -ne "ready" -or $result.url -notlike "mongolgpt-renderer://renderer/*") {
      throw "Installed desktop returned an invalid smoke result: $rawResult"
    }
    if (
      $result.language -ne "mn" -or
      $result.onboardingStage -ne "account" -or
      $result.accountGateVisible -ne $true -or
      $result.accountLogo -ne "mongolgpt" -or
      $result.accountHeading -ne "MongolGPT бүртгэлээрээ нэвтэрнэ үү" -or
      $result.loginAction -ne "Бүртгүүлэх эсвэл нэвтрэх"
    ) {
      throw "Installed desktop did not show the Mongolian MongolGPT account gate: $rawResult"
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
      throw "Installed desktop functional smoke failed: $rawResult"
    }
    if (![string]::IsNullOrWhiteSpace($ExpectedVersionValue) -and $result.version -ne $ExpectedVersionValue) {
      throw "Installed desktop version is $($result.version); expected $ExpectedVersionValue."
    }

    $versionInfo = $Executable.VersionInfo
    if (![string]::IsNullOrWhiteSpace($ExpectedProductNameValue) -and $versionInfo.ProductName -ne $ExpectedProductNameValue) {
      throw "Installed desktop product name is $($versionInfo.ProductName); expected $ExpectedProductNameValue."
    }

    if (!$process.WaitForExit($ExitTimeout * 1000)) {
      throw "Installed desktop reported ready but did not exit cleanly."
    }
    if ($process.ExitCode -ne 0) {
      throw "Installed desktop exited with code $($process.ExitCode)."
    }

    $summary = [PSCustomObject]@{
      executable = $Executable.FullName
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
    Remove-Item -LiteralPath $Marker, $externalPtyProof -Force -ErrorAction SilentlyContinue
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
  return $summary
}

$installer = [System.IO.Path]::GetFullPath($InstallerPath)
if (!(Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Desktop installer does not exist: $installer"
}

$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$tempRoot = [System.IO.Path]::GetFullPath($tempBase).TrimEnd(
  [System.IO.Path]::DirectorySeparatorChar,
  [System.IO.Path]::AltDirectorySeparatorChar
)
$installRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $tempRoot ("mongolgpt-desktop-install-" + [guid]::NewGuid().ToString("N")))
)
$expectedPrefix = $tempRoot + [System.IO.Path]::DirectorySeparatorChar
if (!$installRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Desktop smoke install path түр хавтасны дотор биш байна: $installRoot"
}
$marker = New-SmokeMarkerPath -Candidate $MarkerPath
$installerProcess = $null
$uninstaller = $null
$app = $null
$summary = $null
$failure = $null
$cleanupFailure = $null

New-Item -ItemType Directory -Force -Path $installRoot | Out-Null

try {
  $installerProcess = Start-Process `
    -FilePath $installer `
    -ArgumentList @("/S", "/D=$installRoot") `
    -PassThru `
    -WindowStyle Hidden

  if (!$installerProcess.WaitForExit($InstallTimeoutSeconds * 1000)) {
    throw "Desktop installer $InstallTimeoutSeconds секундэд дууссангүй."
  }
  if ($installerProcess.ExitCode -ne 0) {
    throw "Desktop installer $($installerProcess.ExitCode) кодтой дууслаа."
  }

  $uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter "Uninstall *.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $uninstaller) {
    throw "Desktop installer uninstaller үүсгэсэнгүй: $installRoot"
  }
  $app = Find-InstalledDesktopExecutable -Root $installRoot
  & (Join-Path $PSScriptRoot "verify-branding-windows.ps1") `
    -AppDirectory $installRoot `
    -ExpectedProductName $ExpectedProductName `
    -InstallerPath $installer `
    -UninstallerPath $uninstaller.FullName | Out-Null
  $summary = Invoke-DesktopSmoke `
    -Executable $app `
    -Marker $marker `
    -ExpectedVersionValue $ExpectedVersion `
    -ExpectedProductNameValue $ExpectedProductName `
    -ExternalPtyProbe $UseExternalPtyProbe.IsPresent `
    -ReadyTimeout $ReadyTimeoutSeconds `
    -ExitTimeout $ExitTimeoutSeconds
} catch {
  $failure = $_
} finally {
  if ($null -ne $uninstaller -and (Test-Path -LiteralPath $uninstaller.FullName -PathType Leaf)) {
    try {
      $cleanup = Start-Process `
        -FilePath $uninstaller.FullName `
        -ArgumentList "/S" `
        -PassThru `
        -WindowStyle Hidden
      if (!$cleanup.WaitForExit(60000)) {
        Stop-Process -Id $cleanup.Id -Force -ErrorAction SilentlyContinue
        throw "Desktop uninstaller 60 секундэд дууссангүй."
      }
      if ($cleanup.ExitCode -ne 0) {
        throw "Desktop uninstaller $($cleanup.ExitCode) кодтой дууслаа."
      }
      if ($null -ne $app) {
        $uninstallDeadline = (Get-Date).AddSeconds(10)
        while ((Test-Path -LiteralPath $app.FullName -PathType Leaf) -and (Get-Date) -lt $uninstallDeadline) {
          Start-Sleep -Milliseconds 250
        }
        if (Test-Path -LiteralPath $app.FullName -PathType Leaf) {
          throw "Desktop uninstaller суулгасан executable-ийг арилгасангүй: $($app.FullName)"
        }
      }
    } catch {
      $cleanupFailure = $_
    }
  }
  Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if ($null -ne $failure -and $null -ne $cleanupFailure) {
  throw "$($failure.Exception.Message)`nInstaller cleanup failure: $($cleanupFailure.Exception.Message)"
}
if ($null -ne $failure) {
  throw $failure
}
if ($null -ne $cleanupFailure) {
  throw $cleanupFailure
}

$summary
