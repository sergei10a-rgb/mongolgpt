import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { RuntimeLock } from "@mongolgpt/core/runtime-lock"
import { tmpdir } from "./fixture/tmpdir"

const launcher = process.env.MONGOLGPT_TEST_WORKSPACE_LAUNCHER
const isolated = process.platform === "linux" && process.getuid?.() === 0 && process.geteuid?.() === 0 && !!launcher
const lockNamespace = "/run/mongolgpt-runtime-locks"

describe.skipIf(!isolated)("actual Linux runtime supervisor lock", () => {
  test("excludes a second owner for the same canonical workspace root", async () => {
    await using temp = await tmpdir()
    const root = await workspace(temp.path)
    await using first = await RuntimeLock.acquire({ root, launcher: launcher! })
    expect(first.root).toBe(await realpath(root))
    expect(first.directory).toBe(await expectedDirectory(root))
    await expect(RuntimeLock.acquire({ root, launcher: launcher! })).rejects.toBeInstanceOf(RuntimeLock.LockError)
  })

  test("rejects non-canonical root identities before locking", async () => {
    await using temp = await tmpdir()
    const root = await workspace(temp.path)
    const link = join(temp.path, "workspace-link")
    await symlink(root, link)
    await expect(RuntimeLock.acquire({ root: "workspace", launcher: launcher! })).rejects.toBeInstanceOf(
      RuntimeLock.LockError,
    )
    await expect(RuntimeLock.acquire({ root: link, launcher: launcher! })).rejects.toBeInstanceOf(RuntimeLock.LockError)
  })

  test("releases and reacquires the same root lock", async () => {
    await using temp = await tmpdir()
    const root = await workspace(temp.path)
    const first = await RuntimeLock.acquire({ root, launcher: launcher! })
    await first.close()
    await using second = await RuntimeLock.acquire({ root, launcher: launcher! })
    expect(second.root).toBe(await realpath(root))
  })

  test("releases when the owning parent process is killed", async () => {
    await using temp = await tmpdir()
    const root = await workspace(temp.path)
    const ready = join(temp.path, "child-ready.json")
    const child = spawn(
      process.execPath,
      [process.env.MONGOLGPT_TEST_LOCK_CHILD ?? join(import.meta.dir, "runtime-lock-child.ts"), root, launcher!, ready],
      {
        cwd: import.meta.dir,
        env: { BUN_BE_BUN: "1", PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: ["ignore", "ignore", "inherit"],
      },
    )
    try {
      await waitUntil(async () => existsSync(ready))
      expect(JSON.parse(await readFile(ready, "utf8"))).toMatchObject({
        root: await realpath(root),
        directory: await expectedDirectory(root),
      })
      await expect(RuntimeLock.acquire({ root, launcher: launcher! })).rejects.toBeInstanceOf(RuntimeLock.LockError)
      child.kill("SIGKILL")
      await exited(child)
      await using released = await RuntimeLock.acquire({ root, launcher: launcher! })
      expect(released.root).toBe(await realpath(root))
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited(child).catch(() => {})
    }
  })

  test("rejects an existing lock file with bad permissions", async () => {
    await using temp = await tmpdir()
    const root = await workspace(temp.path)
    const filename = await testLockPath(root)
    await unlink(filename).catch(() => {})
    await writeFile(filename, "bad", { mode: 0o644 })
    try {
      await expect(RuntimeLock.acquire({ root, launcher: launcher! })).rejects.toBeInstanceOf(RuntimeLock.LockError)
    } finally {
      await unlink(filename).catch(() => {})
    }
  })

  test("rejects a symlink lock file", async () => {
    await using temp = await tmpdir()
    const root = await workspace(temp.path)
    const filename = await testLockPath(root)
    const target = join(temp.path, "target")
    await unlink(filename).catch(() => {})
    await writeFile(target, "bad")
    await symlink(target, filename)
    try {
      await expect(RuntimeLock.acquire({ root, launcher: launcher! })).rejects.toBeInstanceOf(RuntimeLock.LockError)
    } finally {
      await unlink(filename).catch(() => {})
    }
  })

  test("closes the parent lock fd when acquisition is aborted", async () => {
    await using temp = await tmpdir()
    const root = await workspace(temp.path)
    const ready = join(temp.path, "launcher-ready")
    const release = join(temp.path, "launcher-release")
    const gated = join(temp.path, "gated-launcher")
    await writeFile(
      gated,
      `#!/bin/sh
printf ready > ${quote(ready)}
while [ ! -e ${quote(release)} ]; do sleep 0.01; done
exec ${quote(launcher!)} "$@"
`,
      { mode: 0o700 },
    )
    await chmod(gated, 0o700)
    const abort = new AbortController()
    const reason = new Error("cancel lock")
    const acquiring = RuntimeLock.acquire({ root, launcher: gated, signal: abort.signal })
    await waitUntil(async () => existsSync(ready))
    abort.abort(reason)
    await expect(acquiring).rejects.toBe(reason)
    await using released = await RuntimeLock.acquire({ root, launcher: launcher! })
    expect(released.root).toBe(await realpath(root))
  })
})

async function workspace(path: string) {
  const root = join(path, "workspace")
  await mkdir(root)
  await chmod(root, 0o755)
  return root
}

async function testLockPath(root: string) {
  await using lock = await RuntimeLock.acquire({ root, launcher: launcher! })
  const filename = join(lock.directory, "lock")
  await lock.close()
  return filename
}

async function expectedDirectory(root: string) {
  return join(
    lockNamespace,
    createHash("sha256")
      .update(await realpath(root))
      .digest("hex"),
  )
}

async function exited(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", () => resolve())
  })
}

async function waitUntil(predicate: () => Promise<boolean> | boolean) {
  const deadline = performance.now() + 5000
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error("runtime lock test did not reach the expected state")
    await setTimeout(10)
  }
}

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
