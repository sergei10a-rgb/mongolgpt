import { describe, expect, test } from "bun:test"
import { chmod, link, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { RuntimeLock } from "@mongolgpt/core/runtime-lock"
import { RuntimeState } from "@mongolgpt/core/runtime-state"
import { tmpdir } from "./fixture/tmpdir"

const launcher = process.env.MONGOLGPT_TEST_WORKSPACE_LAUNCHER
const isolated = process.platform === "linux" && process.getuid?.() === 0 && !!launcher
const record = () => ({ checkpointID: randomUUID(), group: `/sys/fs/cgroup/mongolgpt-${randomUUID()}`, epoch: 2 })

describe.skipIf(!isolated)("root-private runtime resume state", () => {
  test("atomically persists a root-bound record across lock release without cross-workspace reuse", async () => {
    await using temp = await tmpdir()
    const roots = [join(temp.path, "first"), join(temp.path, "second")]
    for (const root of roots) await mkdir(root)
    await using first = await RuntimeLock.acquire({ root: roots[0], launcher: launcher! })
    const state = await RuntimeState.openState(first.directory, roots[0])
    expect(await state.read()).toBeUndefined()
    const data = record()
    await state.write(data)
    const file = await lstat(join(first.directory, "state.json"))
    expect(file.uid).toBe(0)
    expect(file.mode & 0o777).toBe(0o600)
    expect((await readdir(first.directory)).sort()).toEqual(["lock", "state.json"])
    await first.close()
    await using resumed = await RuntimeLock.acquire({ root: roots[0], launcher: launcher! })
    expect(await (await RuntimeState.openState(resumed.directory, roots[0])).read()).toEqual({
      version: 1,
      root: roots[0],
      ...data,
    })
    await using second = await RuntimeLock.acquire({ root: roots[1], launcher: launcher! })
    expect(second.directory).not.toBe(resumed.directory)
    expect(await (await RuntimeState.openState(second.directory, roots[1])).read()).toBeUndefined()
    await expect((await RuntimeState.openState(resumed.directory, roots[1])).read()).rejects.toThrow()
  })

  test("rejects invalid updates without replacing the accepted record", async () => {
    await using temp = await tmpdir()
    await using lock = await RuntimeLock.acquire({ root: temp.path, launcher: launcher! })
    const state = await RuntimeState.openState(lock.directory, temp.path)
    await state.write(record())
    const before = await readFile(join(lock.directory, "state.json"), "utf8")
    for (const epoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(state.write({ ...record(), epoch })).rejects.toThrow()
      expect(await readFile(join(lock.directory, "state.json"), "utf8")).toBe(before)
    }
  })

  test("refuses forged, linked, oversized and permissive state files", async () => {
    await using temp = await tmpdir()
    await using lock = await RuntimeLock.acquire({ root: temp.path, launcher: launcher! })
    const state = await RuntimeState.openState(lock.directory, temp.path)
    const filename = join(lock.directory, "state.json")
    for (const text of [
      "{",
      "x".repeat(4097),
      JSON.stringify({ version: 1, root: temp.path, ...record(), unexpected: true }),
    ]) {
      await writeFile(filename, text, { mode: 0o600 })
      await expect(state.read()).rejects.toThrow()
    }
    await state.write(record())
    await chmod(filename, 0o644)
    await expect(state.read()).rejects.toThrow()
    await chmod(filename, 0o600)
    const target = join(lock.directory, "linked.json")
    await link(filename, target)
    await expect(state.read()).rejects.toThrow()
    await unlink(filename)
    await symlink(target, filename)
    await expect(state.read()).rejects.toThrow()
    await unlink(filename)
    await unlink(target)
  })
})
