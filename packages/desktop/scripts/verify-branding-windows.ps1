param(
  [Parameter(Mandatory = $true)]
  [string]$AppDirectory,

  [string]$ExpectedProductName = "",

  [string]$InstallerPath = "",
  [string]$UninstallerPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$forbiddenBrand = '(?i)(?:\bOpenCode\b|opencode\.ai|anomalyco|@opencode/|github\.com/(?:sst|anomalyco)/opencode)'
$textExtensions = [System.Collections.Generic.HashSet[string]]::new(
  [string[]]@(".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".txt", ".yaml", ".yml"),
  [System.StringComparer]::OrdinalIgnoreCase
)

function Assert-NoLegacyBrand {
  param(
    [string]$Label,
    [AllowEmptyString()]
    [string]$Value
  )

  if (![string]::IsNullOrWhiteSpace($Value) -and $Value -match $forbiddenBrand) {
    throw "Windows artifact-д хуучин брэнд илэрлээ: $Label; token=$($Matches[0])"
  }
}

function Assert-ExecutableBranding {
  param(
    [System.IO.FileInfo]$Executable,
    [string]$RequiredProductName = ""
  )

  $versionInfo = $Executable.VersionInfo
  if (![string]::IsNullOrWhiteSpace($RequiredProductName) -and $versionInfo.ProductName -ne $RequiredProductName) {
    throw "$($Executable.Name) product name нь $($versionInfo.ProductName); хүлээсэн утга: $RequiredProductName"
  }

  foreach ($field in @("CompanyName", "FileDescription", "InternalName", "OriginalFilename", "ProductName")) {
    Assert-NoLegacyBrand -Label "$($Executable.Name).$field" -Value ([string]$versionInfo.$field)
  }
}

$appRoot = [System.IO.Path]::GetFullPath($AppDirectory)
if (!(Test-Path -LiteralPath $appRoot -PathType Container)) {
  throw "Windows packaged app directory олдсонгүй: $appRoot"
}

$apps = @(
  Get-ChildItem -LiteralPath $appRoot -Filter "*.exe" -File |
    Where-Object {
      $_.Name -notmatch "^Uninstall " -and
      $_.Name -notmatch "^unins.*\.exe$" -and
      $_.Name -notmatch "mongolgpt-cli" -and
      $_.Name -notmatch "^elevate\.exe$" -and
      $_.Name -notmatch "^OpenConsole\.exe$"
    }
)
if ($apps.Count -ne 1) {
  throw "Windows artifact нэг desktop executable-тэй байх ёстой; олдсон: $($apps.Count)"
}
$productName = [string]$apps[0].VersionInfo.ProductName
if ([string]::IsNullOrWhiteSpace($productName)) {
  throw "Windows desktop executable ProductName metadata-гүй байна: $($apps[0].Name)"
}
if (![string]::IsNullOrWhiteSpace($ExpectedProductName) -and $productName -ne $ExpectedProductName) {
  throw "Windows desktop product name нь $productName; хүлээсэн утга: $ExpectedProductName"
}
Assert-NoLegacyBrand -Label "product name" -Value $productName
if ($apps[0].Name -ne "$productName.exe") {
  throw "Windows desktop executable нэр буруу: $($apps[0].Name); хүлээсэн утга: $productName.exe"
}
Assert-ExecutableBranding -Executable $apps[0] -RequiredProductName $productName

foreach ($entry in Get-ChildItem -LiteralPath $appRoot -Recurse -Force) {
  $relative = [System.IO.Path]::GetRelativePath($appRoot, $entry.FullName)
  Assert-NoLegacyBrand -Label "artifact path" -Value $relative
}

foreach ($file in Get-ChildItem -LiteralPath $appRoot -Recurse -File -Force) {
  if (!$textExtensions.Contains($file.Extension)) { continue }
  if ($file.Name -match '^(?:LICENSE|THIRD_PARTY_NOTICES)(?:\.|$)') { continue }

  $relative = [System.IO.Path]::GetRelativePath($appRoot, $file.FullName)
  Assert-NoLegacyBrand -Label $relative -Value ([System.IO.File]::ReadAllText($file.FullName))
}

foreach ($candidate in @($InstallerPath, $UninstallerPath)) {
  if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
  $resolved = [System.IO.Path]::GetFullPath($candidate)
  if (!(Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "Windows branding metadata шалгах файл олдсонгүй: $resolved"
  }
  $file = Get-Item -LiteralPath $resolved
  Assert-NoLegacyBrand -Label "artifact filename" -Value $file.Name
  Assert-ExecutableBranding -Executable $file
}

[pscustomobject]@{
  appDirectory = $appRoot
  executable = $apps[0].Name
  productName = $productName
  installerChecked = ![string]::IsNullOrWhiteSpace($InstallerPath)
  uninstallerChecked = ![string]::IsNullOrWhiteSpace($UninstallerPath)
  status = "branded"
}
