param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,
  [Parameter(Mandatory = $true)]
  [string]$ProofPath,
  [ValidateRange(1, 120)]
  [int]$TimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Quote-ProcessArgument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

$executable = [System.IO.Path]::GetFullPath($ExecutablePath)
if (!(Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "Packaged PTY executable does not exist: $executable"
}

$proof = [System.IO.Path]::GetFullPath($ProofPath)
$probe = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "smoke-packaged-pty.cjs")).Path
$module = Join-Path `
  (Split-Path -Parent $executable) `
  "resources\app.asar.unpacked\node_modules\@lydell\node-pty-win32-x64\lib\index.js"
if (!(Test-Path -LiteralPath $module -PathType Leaf)) {
  throw "Packaged Windows PTY module does not exist: $module"
}

$stdout = "$proof.stdout.log"
$stderr = "$proof.stderr.log"
$process = $null
$failure = $null

Remove-Item -LiteralPath $proof, $stdout, $stderr -Force -ErrorAction SilentlyContinue
try {
  $process = Start-Process `
    -FilePath $executable `
    -ArgumentList @(
      (Quote-ProcessArgument $probe),
      (Quote-ProcessArgument $module),
      (Quote-ProcessArgument $proof)
    ) `
    -Environment @{ ELECTRON_RUN_AS_NODE = "1" } `
    -WorkingDirectory (Split-Path -Parent $executable) `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr

  if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
    throw "Packaged PTY probe did not finish within $TimeoutSeconds seconds."
  }
  if ($process.ExitCode -ne 0) {
    throw "Packaged PTY probe exited with code $($process.ExitCode)."
  }
  if (!(Test-Path -LiteralPath $proof -PathType Leaf)) {
    throw "Packaged PTY probe did not create its proof file."
  }
  $value = (Get-Content -Raw -LiteralPath $proof).Trim()
  if ($value -ne "MONGOLGPT_PACKAGED_PTY_OK") {
    throw "Packaged PTY proof is invalid."
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
[PSCustomObject]@{
  executable = $executable
  module = $module
  proof = $proof
  status = "ready"
}
