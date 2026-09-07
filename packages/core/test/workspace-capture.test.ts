import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Effect } from "effect"
import { DatabaseBackup } from "@mongolgpt/core/database/backup"
import { WorkspaceCapture } from "@mongolgpt/core/database/workspace-capture"
import { WorkspaceRestore } from "@mongolgpt/core/database/workspace-restore"
import { tmpdir } from "./fixture/tmpdir"

const ioTimeout = 30_000
const maxFileBytes = 8 * 1024 * 1024

describe("workspace file capture", () => {
  test(
    "captures independent snapshots and restores current bytes without resurrecting deleted files",
    async () => {
      await using temp = await tmpdir()
      const source = join(temp.path, "source")
      await mkdir(join(source, "bin"), { recursive: true })
      await writeFile(join(source, "keep.txt"), "old")
      await writeFile(join(source, "delete.txt"), "delete me")
      await writeFile(join(source, "bin", "run.sh"), "#!/bin/sh\necho old\n")
      if (process.platform !== "win32") await chmod(join(source, "bin", "run.sh"), 0o755)
      const first = await capture(source, join(temp.path, "first.archive"))

      await writeFile(join(source, "keep.txt"), "new bytes")
      await unlink(join(source, "delete.txt"))
      await writeFile(join(source, "new.bin"), Buffer.from([0, 1, 2, 255]))
      await writeFile(join(source, "bin", "run.sh"), "#!/bin/sh\necho new\n")
      if (process.platform !== "win32") await chmod(join(source, "bin", "run.sh"), 0o755)
      const second = await capture(source, join(temp.path, "second.archive"))

      const oldRestore = await restore(first, join(temp.path, "old-restore"))
      const currentRestore = await restore(second, join(temp.path, "current-restore"))

      expect(first.summary).toEqual({ files: 3, directories: 1, bytes: 31 })
      expect(second.summary).toEqual({ files: 3, directories: 1, bytes: 32 })
      expect(await readFile(join(oldRestore, "delete.txt"), "utf8")).toBe("delete me")
      expect(await readFile(join(currentRestore, "keep.txt"), "utf8")).toBe("new bytes")
      expect(await exists(join(currentRestore, "delete.txt"))).toBe(false)
      expect(await readFile(join(currentRestore, "new.bin"))).toEqual(Buffer.from([0, 1, 2, 255]))
      if (process.platform !== "win32")
        expect((await stat(join(currentRestore, "bin", "run.sh"))).mode & 0o777).toBe(0o700)
    },
    ioTimeout,
  )

  test(
    "captures binary, unicode and explicitly excluded file paths without implicit filtering",
    async () => {
      await using temp = await tmpdir()
      const source = join(temp.path, "source")
      await mkdir(join(source, "cache"), { recursive: true })
      await writeFile(join(source, "Монгол.txt"), "сайн байна\n")
      await writeFile(join(source, "cache", "kept.txt"), "kept")
      await writeFile(join(source, "runtime.sqlite"), "database")
      await writeFile(join(source, "runtime.sqlite-wal"), "wal")

      const result = await capture(join(temp.path, "source"), join(temp.path, "files.archive"), [
        "runtime.sqlite",
        "runtime.sqlite-wal",
        "runtime.sqlite-shm",
      ])
      const restored = await restore(result, join(temp.path, "restored"))

      expect(result.summary).toEqual({
        files: 2,
        directories: 1,
        bytes: Buffer.byteLength("сайн байна\n") + Buffer.byteLength("kept"),
      })
      expect(await readFile(join(restored, "Монгол.txt"), "utf8")).toBe("сайн байна\n")
      expect(await readFile(join(restored, "cache", "kept.txt"), "utf8")).toBe("kept")
      expect(await exists(join(restored, "runtime.sqlite"))).toBe(false)
      expect(await exists(join(restored, "runtime.sqlite-wal"))).toBe(false)
    },
    ioTimeout,
  )

  test("rejects excluded directories instead of silently skipping trees", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source")
    await mkdir(join(source, "cache"), { recursive: true })
    await writeFile(join(source, "cache", "data.txt"), "data")

    await expectCaptureFailure(source, join(temp.path, "bad.archive"), ["cache"])

    expect(await exists(join(temp.path, "bad.archive"))).toBe(false)
  })

  test.skipIf(process.platform === "win32")("rejects source symlinks without following them", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source")
    const outside = join(temp.path, "outside")
    await mkdir(source)
    await writeFile(outside, "outside")
    await symlink(outside, join(source, "link"))

    await expectCaptureFailure(source, join(temp.path, "link.archive"))

    expect(await readFile(outside, "utf8")).toBe("outside")
    expect(await exists(join(temp.path, "link.archive"))).toBe(false)
  })

  test("rejects oversized files without publishing a destination", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source")
    await mkdir(source)
    await writeFile(join(source, "large.bin"), Buffer.alloc(maxFileBytes + 1))

    await expectCaptureFailure(source, join(temp.path, "oversized.archive"))

    expect(await exists(join(temp.path, "oversized.archive"))).toBe(false)
  })

  test("rejects total byte limits before publishing a destination", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source")
    await mkdir(source)
    await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        writeFile(join(source, `large-${index}.bin`), Buffer.alloc(maxFileBytes, index + 1)),
      ),
    )

    await expectCaptureFailure(source, join(temp.path, "total.archive"))

    expect(await exists(join(temp.path, "total.archive"))).toBe(false)
    expect(await hasStaging(temp.path)).toBe(false)
  }, 120_000)

  test("does not clobber existing destinations", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source")
    const destination = join(temp.path, "existing.archive")
    await mkdir(source)
    await writeFile(join(source, "file.txt"), "capture")
    await writeFile(destination, "keep")

    await expectCaptureFailure(source, destination)

    expect(await readFile(destination, "utf8")).toBe("keep")
  })

  test("rejects destinations inside the source tree", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source")
    await mkdir(source)
    await writeFile(join(source, "file.txt"), "capture")

    await expectCaptureFailure(source, join(source, "inside.archive"))

    expect(await exists(join(source, "inside.archive"))).toBe(false)
  })

  test("rejects changing source inventories", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source")
    await mkdir(source)
    await writeFile(join(source, "flip.txt"), "0")
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeFile(join(source, `large-${index}.bin`), Buffer.alloc(1024 * 1024, index)),
      ),
    )
    let stop = false
    const changing = (async () => {
      for (let index = 1; !stop; index++) {
        await writeFile(join(source, "flip.txt"), String(index % 10))
      }
    })()
    try {
      await expectCaptureFailure(source, join(temp.path, "changing.archive"))
    } finally {
      stop = true
      await changing
    }
    expect(await exists(join(temp.path, "changing.archive"))).toBe(false)
  }, 120_000)

  test("cleans up early aborts before staging", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source")
    const destination = join(temp.path, "early-abort.archive")
    await mkdir(source)
    await writeFile(join(source, "file.txt"), "capture")
    const controller = new AbortController()
    controller.abort()

    const result = await Effect.runPromise(WorkspaceCapture.create({ source, destination, key: randomBytes(32) }), {
      signal: controller.signal,
    }).then(
      () => true,
      () => false,
    )

    expect(result).toBe(false)
    expect(await exists(destination)).toBe(false)
    expect(await hasStaging(temp.path)).toBe(false)
  })

  test("waits for cancelled capture cleanup before settling", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source")
    const destination = join(temp.path, "cancelled.archive")
    await mkdir(source)
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeFile(join(source, `large-${index}.bin`), Buffer.alloc(maxFileBytes, index + 1)),
      ),
    )
    const controller = new AbortController()
    let settled = false
    const running = Effect.runPromise(WorkspaceCapture.create({ source, destination, key: randomBytes(32) }), {
      signal: controller.signal,
    })
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        settled = true
      })
    try {
      const deadline = Date.now() + 30_000
      while (!(await hasStaging(temp.path)) && !settled) {
        if (Date.now() > deadline) throw new Error("capture cancellation fixture did not start")
        await Bun.sleep(5)
      }
      expect(settled).toBe(false)
      controller.abort()
      expect(await running).toBe(false)
      expect(await exists(destination)).toBe(false)
      await Bun.sleep(50)
      expect(await hasStaging(temp.path)).toBe(false)
    } finally {
      controller.abort()
      await running
    }
  }, 120_000)
})

async function capture(source: string, destination: string, exclude?: readonly string[]) {
  const key = randomBytes(32)
  const result = await Effect.runPromise(WorkspaceCapture.create({ source, destination, key, exclude }))
  const restored = join(dirname(destination), `${basename(destination)}.sqlite`)
  expect(await Effect.runPromise(DatabaseBackup.restore({ source: destination, destination: restored, key }))).toEqual(
    result.report,
  )
  return { ...result, source: restored, expected: result.report }
}

async function restore(fixture: { source: string; expected: DatabaseBackup.Report }, destination: string) {
  await Effect.runPromise(WorkspaceRestore.materialize({ ...fixture, destination }))
  return destination
}

async function expectCaptureFailure(source: string, destination: string, exclude?: readonly string[]) {
  const error = await Effect.runPromise(
    Effect.flip(WorkspaceCapture.create({ source, destination, key: randomBytes(32), exclude })),
  )
  expect(error.message).toBe("Ажлын талбарын агшингийн эх, зорилтот зам эсвэл архивын бүтэц буруу байна.")
}

async function exists(path: string) {
  return lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })
}

async function hasStaging(directory: string) {
  return (await readdir(directory)).some((name) => name.startsWith(".mongolgpt-workspace-capture-"))
}
