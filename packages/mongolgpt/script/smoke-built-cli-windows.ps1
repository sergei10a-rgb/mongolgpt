param(
  [Parameter(Mandatory = $true)]
  [string]$BinaryPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedAccountUrl,

  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$binary = (Resolve-Path -LiteralPath $BinaryPath).Path
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("mongolgpt-cli-smoke-" + [guid]::NewGuid().ToString("N"))
$repo = Join-Path $root "repo"
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

function New-MongolGPTStartInfo {
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
  foreach ($entry in $isolated.GetEnumerator()) {
    $start.Environment[$entry.Key] = $entry.Value
  }

  return $start
}

function Invoke-MongolGPT {
  param([string[]]$Arguments)

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = New-MongolGPTStartInfo -Arguments $Arguments
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

function Test-ServerAccountGate {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = New-MongolGPTStartInfo -Arguments @(
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    [string]$port
  )
  $process.StartInfo.Environment["MONGOLGPT_SERVER_PASSWORD"] = "smoke-secret"
  if (-not $process.Start()) {
    throw "MongolGPT server account gate smoke-г эхлүүлж чадсангүй"
  }
  $process.StandardInput.Close()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $client = [System.Net.Http.HttpClient]::new()
  $unauthenticatedClient = [System.Net.Http.HttpClient]::new()
  $client.Timeout = [TimeSpan]::FromSeconds(2)
  $unauthenticatedClient.Timeout = [TimeSpan]::FromSeconds(2)
  $credential = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("mongolgpt:smoke-secret"))
  $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Basic", $credential)

  try {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited) {
      try {
        $health = $client.GetAsync("http://127.0.0.1:$port/api/health").GetAwaiter().GetResult()
        $ready = [int]$health.StatusCode -eq 200
        $health.Dispose()
        if ($ready) { break }
      }
      catch {
        Start-Sleep -Milliseconds 200
      }
    }
    if (-not $ready) {
      throw "MongolGPT server account gate smoke-д хугацаандаа бэлэн болсонгүй"
    }

    $unauthenticatedContent = [System.Net.Http.StringContent]::new("{}", [System.Text.Encoding]::UTF8, "application/json")
    $unauthenticated = $unauthenticatedClient.PostAsync("http://127.0.0.1:$port/session", $unauthenticatedContent).GetAwaiter().GetResult()
    if ([int]$unauthenticated.StatusCode -ne 401) {
      throw "HTTP account gate server auth-ийг түрүүлж мөрдсөнгүй: status=$([int]$unauthenticated.StatusCode)"
    }
    $unauthenticated.Dispose()
    $unauthenticatedContent.Dispose()

    foreach ($path in @("/session", "/api/session")) {
      $content = [System.Net.Http.StringContent]::new("{}", [System.Text.Encoding]::UTF8, "application/json")
      $response = $client.PostAsync("http://127.0.0.1:$port$path", $content).GetAwaiter().GetResult()
      $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if ([int]$response.StatusCode -ne 403 -or $body -notmatch "mongolgpt account login") {
        throw "HTTP account gate буруу хариу өглөө: path=$path, status=$([int]$response.StatusCode), body=$body"
      }
      $response.Dispose()
      $content.Dispose()
    }
  }
  finally {
    $client.Dispose()
    $unauthenticatedClient.Dispose()
    if (-not $process.HasExited) {
      $process.Kill($true)
      $process.WaitForExit()
    }
    [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask))
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

  $accountLoginHelp = Invoke-MongolGPT -Arguments @("account", "login", "--help")
  $accountLoginHelpText = $accountLoginHelp.Stdout + $accountLoginHelp.Stderr
  if ($accountLoginHelp.ExitCode -ne 0 -or -not $accountLoginHelpText.Contains($ExpectedAccountUrl)) {
    throw "account login --help нь build-ийн бүртгэлийн URL-ийг харуулсангүй: expected=$ExpectedAccountUrl, stderr=$($accountLoginHelp.Stderr.Trim())"
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

  $optionalProvider = Invoke-MongolGPT -Arguments @(
    "run",
    "--model",
    "ollama/account-gate-smoke",
    "--format",
    "json",
    "release smoke"
  )
  if ($optionalProvider.ExitCode -eq 0) {
    throw "Нэвтрээгүй нэмэлт provider хүсэлт амжилттай болсон тул release-ийг хориглолоо"
  }
  if ($optionalProvider.Stderr -notmatch "mongolgpt account login") {
    throw "Нэмэлт provider-ийн нэвтрэх хаалт зөв тайлбар буцаасангүй: $($optionalProvider.Stderr.Trim())"
  }

  foreach ($attachArguments in @(
    @("run", "--attach", "http://127.0.0.1:1", "--model", "ollama/account-gate-smoke", "--format", "json", "release smoke"),
    @("attach", "http://127.0.0.1:1")
  )) {
    $attached = Invoke-MongolGPT -Arguments $attachArguments
    if ($attached.ExitCode -eq 0) {
      throw "Нэвтрээгүй attach хүсэлт амжилттай болсон тул release-ийг хориглолоо: $($attachArguments -join ' ')"
    }
    if ($attached.Stderr -notmatch "холбогдсон сервер дээр.*бүртгэлээр нэвтэрч") {
      throw "Attach нэвтрэх хаалт зөв тайлбар буцаасангүй: $($attached.Stderr.Trim())"
    }
  }

  Test-ServerAccountGate

  Write-Host "MongolGPT Windows CLI smoke амжилттай: version, account URL, Git repo, Free Auto, нэмэлт provider, attach болон HTTP account gate"
}
finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
