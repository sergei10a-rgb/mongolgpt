param(
  [Parameter(Mandatory = $true)]
  [string]$BinaryPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,

  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$binary = (Resolve-Path -LiteralPath $BinaryPath).Path
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("mongolgpt-cli-smoke-" + [guid]::NewGuid().ToString("N"))
$repo = Join-Path $root "repo"

function Invoke-MongolGPT {
  param([string[]]$Arguments)

  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $binary
  $start.WorkingDirectory = $repo
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true

  foreach ($argument in $Arguments) {
    $start.ArgumentList.Add($argument)
  }

  $isolated = @{
    "MONGOLGPT_TEST_HOME" = $root
    "HOME" = $root
    "USERPROFILE" = $root
    "APPDATA" = (Join-Path $root "AppData\Roaming")
    "LOCALAPPDATA" = (Join-Path $root "AppData\Local")
    "XDG_CONFIG_HOME" = (Join-Path $root ".config")
    "XDG_DATA_HOME" = (Join-Path $root ".local\share")
    "XDG_STATE_HOME" = (Join-Path $root ".local\state")
    "XDG_CACHE_HOME" = (Join-Path $root ".cache")
    "MONGOLGPT_CONFIG_CONTENT" = '{"formatter":false,"lsp":false}'
    "MONGOLGPT_AUTH_CONTENT" = "{}"
    "MONGOLGPT_API_KEY" = ""
    "MONGOLGPT_DISABLE_PROJECT_CONFIG" = "1"
    "MONGOLGPT_DISABLE_AUTOUPDATE" = "1"
    "MONGOLGPT_DISABLE_AUTOCOMPACT" = "1"
    "MONGOLGPT_DISABLE_MODELS_FETCH" = "1"
    "MONGOLGPT_PURE" = "1"
  }
  foreach ($entry in $isolated.GetEnumerator()) {
    $start.Environment[$entry.Key] = $entry.Value
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) {
    throw "MongolGPT CLI процессыг эхлүүлж чадсангүй"
  }
  $process.StandardInput.Close()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()

  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill($true)
    $process.WaitForExit()
    throw "MongolGPT CLI smoke $TimeoutSeconds секундэд дууссангүй: $($Arguments -join ' ')"
  }

  [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask))
  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    Stdout = $stdoutTask.Result
    Stderr = $stderrTask.Result
  }
}

try {
  New-Item -ItemType Directory -Path $repo -Force | Out-Null
  git -C $repo init --quiet
  if ($LASTEXITCODE -ne 0) {
    throw "CLI smoke-ийн түр Git repo-г үүсгэж чадсангүй"
  }

  $version = Invoke-MongolGPT -Arguments @("--version")
  if ($version.ExitCode -ne 0 -or $version.Stdout.Trim() -ne $ExpectedVersion) {
    throw "--version smoke амжилтгүй: exit=$($version.ExitCode), stdout=$($version.Stdout.Trim()), stderr=$($version.Stderr.Trim())"
  }

  $help = Invoke-MongolGPT -Arguments @("--help")
  $helpText = $help.Stdout + $help.Stderr
  if ($help.ExitCode -ne 0 -or $helpText -notmatch "(?i)mongolgpt") {
    throw "--help smoke амжилтгүй: exit=$($help.ExitCode), stderr=$($help.Stderr.Trim())"
  }

  $accountHelp = Invoke-MongolGPT -Arguments @("account", "--help")
  $accountHelpText = $accountHelp.Stdout + $accountHelp.Stderr
  if ($accountHelp.ExitCode -ne 0 -or $accountHelpText -notmatch "MongolGPT бүртгэл") {
    throw "account --help smoke амжилтгүй: exit=$($accountHelp.ExitCode), stderr=$($accountHelp.Stderr.Trim())"
  }

  $freeAuto = Invoke-MongolGPT -Arguments @(
    "run",
    "--model",
    "mongolgpt/free-auto",
    "--format",
    "json",
    "release smoke"
  )
  if ($freeAuto.ExitCode -eq 0) {
    throw "Нэвтрээгүй Free Auto хүсэлт амжилттай болсон тул release-ийг хориглолоо"
  }
  if ($freeAuto.Stderr -notmatch "mongolgpt account login") {
    throw "Free Auto нэвтрэх хаалт зөв тайлбар буцаасангүй: $($freeAuto.Stderr.Trim())"
  }

  Write-Host "MongolGPT Windows CLI smoke амжилттай: version, account help, Git repo, Free Auto account gate"
}
finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
