import { execFile } from "node:child_process"
import { chmod, lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)

/** Only for new, empty staging paths inside a trusted private parent, never an existing user file. */
export async function protectBackupPath(path: string, kind: "file" | "directory") {
  const info = await lstat(path)
  if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() || info.size !== 0 : !info.isDirectory())) {
    throw new Error("Invalid backup staging path")
  }
  if (kind === "directory" && (await readdir(path)).length !== 0) throw new Error("Nonempty backup staging path")
  if (process.platform !== "win32") return chmod(path, kind === "directory" ? 0o700 : 0o600)

  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32")
  // Removing inheritance alone leaves explicit grants (including administrator defaults).
  // Replace the entire DACL on the empty path, then read it back before any data is written.
  await execute(
    join(system, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", windowsPermissions],
    {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4096,
      env: { ...process.env, MONGOLGPT_BACKUP_PATH: path, MONGOLGPT_BACKUP_PATH_KIND: kind },
    },
  )
}

const windowsPermissions = `
$ErrorActionPreference = 'Stop'
$path = $env:MONGOLGPT_BACKUP_PATH
$directory = $env:MONGOLGPT_BACKUP_PATH_KIND -eq 'directory'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$principals = @($user)
if ($user.Value -ne $system.Value) { $principals += $system }
$inherit = [Security.AccessControl.InheritanceFlags]::None
if ($directory) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  $acl = [Security.AccessControl.FileSecurity]::new()
}
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($principal in $principals) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $principal, [Security.AccessControl.FileSystemRights]::FullControl, $inherit,
    [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
}
if ($directory) { [IO.Directory]::SetAccessControl($path, $acl) }
else { [IO.File]::SetAccessControl($path, $acl) }
if ($directory) { $actual = [IO.Directory]::GetAccessControl($path) }
else { $actual = [IO.File]::GetAccessControl($path) }
$rules = $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
if (!$actual.AreAccessRulesProtected -or $rules.Count -ne $principals.Count) { throw 'Invalid backup ACL' }
foreach ($principal in $principals) {
  $matched = 0
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $principal.Value) { continue }
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or
        $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $inherit -or
        $rule.PropagationFlags -ne 'None') { throw 'Invalid backup rights' }
    $matched++
  }
  if ($matched -ne 1) { throw 'Missing backup principal' }
}
`
