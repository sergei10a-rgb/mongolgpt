import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { protectBackupPath } from "../src/database/backup-permissions"
import { tmpdir } from "./fixture/tmpdir"

const execute = promisify(execFile)

test("backup permissions reject existing content and mismatched path kinds", async () => {
  await using temp = await tmpdir()
  const path = join(temp.path, "existing.sqlite")
  await writeFile(path, "existing content")
  await expect(protectBackupPath(path, "file")).rejects.toThrow("Invalid backup staging path")
  await expect(protectBackupPath(path, "directory")).rejects.toThrow("Invalid backup staging path")
  await expect(protectBackupPath(temp.path, "file")).rejects.toThrow("Invalid backup staging path")
  await expect(protectBackupPath(temp.path, "directory")).rejects.toThrow("Nonempty backup staging path")
  expect(await readFile(path, "utf8")).toBe("existing content")
})

test.skipIf(process.platform === "win32")("backup staging uses private POSIX modes", async () => {
  await using temp = await tmpdir()
  const directory = join(temp.path, "directory")
  const file = join(temp.path, "file")
  await mkdir(directory, { mode: 0o755 })
  await writeFile(file, "", { mode: 0o644 })
  await protectBackupPath(directory, "directory")
  await protectBackupPath(file, "file")
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
})

test.skipIf(process.platform !== "win32")(
  "backup staging replaces explicit and inherited Windows grants",
  async () => {
    await using temp = await tmpdir()
    for (const kind of ["directory", "file"] as const) {
      const path = join(temp.path, kind)
      if (kind === "directory") await mkdir(path)
      else await writeFile(path, "")
      await execute("icacls.exe", [path, "/grant", "*S-1-1-0:F", "*S-1-5-32-544:F"], { windowsHide: true })
      await protectBackupPath(path, kind)
      const result = await execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=[IO.File]::GetAccessControl($env:MONGOLGPT_BACKUP_TEST_PATH); if(!$acl.AreAccessRulesProtected){throw 'Inherited ACL'}; foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if($rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl'){throw 'Unexpected rights'}; $sid=$rule.IdentityReference.Value; if($sid -eq $me){'self'}elseif($sid -eq 'S-1-5-18'){'system'}else{$sid} }",
        ],
        { windowsHide: true, env: { ...process.env, MONGOLGPT_BACKUP_TEST_PATH: path } },
      )
      expect(result.stdout.trim().split(/\r?\n/).sort()).toEqual(["self", "system"])
    }
  },
  30_000,
)
