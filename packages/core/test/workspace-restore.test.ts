import { describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { Effect } from "effect"
import { DatabaseBackup } from "@mongolgpt/core/database/backup"
import { WorkspaceRestore } from "@mongolgpt/core/database/workspace-restore"
import { tmpdir } from "./fixture/tmpdir"

type Entry = { path: string; type: "file" | "directory"; mode: number; content?: Uint8Array }
type RawValue = string | number | Uint8Array | null
type RawRow = {
  path: RawValue
  type: RawValue
  mode: RawValue
  bytes: RawValue
  sha256: RawValue
  content: RawValue
}

const ioTimeout = 30_000
const maxFileBytes = 8 * 1024 * 1024
const maxTotalBytes = 64 * 1024 * 1024

describe("workspace file restore materializer", () => {
  test(
    "materializes a real restored archive with binary content, unicode names and executable bits",
    async () => {
      await using temp = await tmpdir()
      const binary = Buffer.from([0, 1, 2, 127, 255])
      const script = Buffer.from("#!/bin/sh\necho restored\n")
      const fixture = await archiveRestore(temp.path, "roundtrip", [
        dir("project", 0o755),
        dir("project/bin", 0o755),
        file("project/Монгол файл.txt", "сайн байна\n", 0o600),
        file("project/bin/run.sh", script, 0o755),
        file("binary/data.bin", binary, 0o600, ["binary"]),
      ])
      const before = await readFile(fixture.source)
      const destination = join(temp.path, "restored-workspace")

      const summary = await materialize(fixture, destination)

      expect(summary).toEqual({
        files: 3,
        directories: 3,
        bytes: Buffer.byteLength("сайн байна\n") + script.length + binary.length,
      })
      expect(await readFile(join(destination, "project", "Монгол файл.txt"), "utf8")).toBe("сайн байна\n")
      expect(await readFile(join(destination, "binary", "data.bin"))).toEqual(binary)
      expect(await readFile(join(destination, "project", "bin", "run.sh"))).toEqual(script)
      expect(await readFile(fixture.source)).toEqual(before)
      expect(await sidecars(temp.path, basename(fixture.source))).toEqual([])
      if (process.platform !== "win32") {
        expect((await stat(destination)).mode & 0o777).toBe(0o700)
        expect((await stat(join(destination, "project", "bin", "run.sh"))).mode & 0o777).toBe(0o700)
        expect((await stat(join(destination, "project", "Монгол файл.txt"))).mode & 0o777).toBe(0o600)
      }
    },
    ioTimeout,
  )

  for (const [name, entries] of [
    ["traversal", [file("../escape.txt", "x")]],
    ["absolute", [file("/absolute.txt", "x")]],
    ["drive", [file("C:/drive.txt", "x")]],
    ["backslash", [file("safe\\name.txt", "x")]],
    ["nul", [file("safe/\0name.txt", "x", 0o600, ["safe"])]],
    ["control", [file("safe/\u0001.txt", "x", 0o600, ["safe"])]],
    ["dot", [file("safe/./name.txt", "x", 0o600, ["safe"])]],
    ["trailing-space", [file("safe/name .txt ", "x", 0o600, ["safe"])]],
    ["trailing-dot", [file("safe/name.", "x", 0o600, ["safe"])]],
    ["windows-unsafe", [file("safe/name:stream", "x", 0o600, ["safe"])]],
    ["windows-illegal", [file('safe/<bad>"name|?*.txt', "x", 0o600, ["safe"])]],
    ["missing-parent", [file("missing/child.txt", "x")]],
    ["reserved", [file("CON/file.txt", "x", 0o600, ["CON"])]],
    ["reserved-superscript", [file("COM¹/file.txt", "x", 0o600, ["COM¹"])]],
    ["casefold", [file("Case.txt", "a"), file("case.txt", "b")]],
  ] as Array<[string, Array<Entry | Entry[]>]>) {
    test.skipIf(name === "casefold" && process.platform !== "win32")(
      `rejects unsafe path case ${name} without leaving a destination`,
      async () => {
        await using temp = await tmpdir()
        const fixture = await archiveRestore(temp.path, name, entries)
        const destination = join(temp.path, `restore-${name}`)

        await expectFailure(fixture, destination)

        expect(await exists(destination)).toBe(false)
      },
      ioTimeout,
    )
  }

  test(
    "rejects row hash mismatches and removes only paths created by the call",
    async () => {
      await using temp = await tmpdir()
      const keep = join(temp.path, "keep.txt")
      await writeFile(keep, "preexisting")
      const fixture = await archiveRestore(temp.path, "hash-mismatch", [
        dir("project"),
        file("project/ok.txt", "ok"),
        raw({
          path: "project/zzz-bad.txt",
          type: "file",
          mode: 0o600,
          bytes: 3,
          sha256: digest(Buffer.from("not the bytes")),
          content: Buffer.from("bad"),
        }),
      ])
      const before = await readFile(fixture.source)
      const destination = join(temp.path, "failed-restore")

      await expectFailure(fixture, destination)

      expect(await exists(destination)).toBe(false)
      expect(await readFile(keep, "utf8")).toBe("preexisting")
      expect(await readFile(fixture.source)).toEqual(before)
    },
    ioTimeout,
  )

  test(
    "rejects malformed schemas, views, symlink entry types and oversized rows during preflight",
    async () => {
      await using temp = await tmpdir()
      const badSchema = await archiveRestore(temp.path, "bad-schema", [], (db) => {
        db.run("DROP TABLE file")
        db.run(
          "CREATE TABLE file(path TEXT PRIMARY KEY, type TEXT NOT NULL, mode TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT, content BLOB)",
        )
      })
      await expectFailure(badSchema, join(temp.path, "bad-schema-restore"))

      const malformed = await archiveRestore(temp.path, "malformed", [
        raw({ path: "bad", type: "symlink", mode: 0o600, bytes: 0, sha256: null, content: null }),
      ])
      await expectFailure(malformed, join(temp.path, "malformed-restore"))

      const oversized = await archiveRestore(temp.path, "oversized", [
        raw({
          path: "large.bin",
          type: "file",
          mode: 0o600,
          bytes: maxFileBytes + 1,
          sha256: digest(Buffer.from("x")),
          content: Buffer.from("x"),
        }),
      ])
      await expectFailure(oversized, join(temp.path, "oversized-restore"))

      const view = await archiveRestore(temp.path, "view", [], (db) => {
        db.run("DROP TABLE file")
        db.run("CREATE VIEW file AS SELECT 'x' AS path")
      })
      await expectFailure(view, join(temp.path, "view-restore"))
    },
    ioTimeout,
  )

  test("rejects entry count and total byte limits before materializing content", async () => {
    await using temp = await tmpdir()
    const tooMany = await archiveRestore(temp.path, "too-many", [], (db) => {
      const insert = db.query("INSERT INTO file VALUES (?, 'directory', 448, 0, NULL, NULL)")
      db.run("BEGIN")
      try {
        for (let index = 0; index < 10_001; index++) insert.run(`dir-${index.toString().padStart(5, "0")}`)
        db.run("COMMIT")
      } catch (error) {
        db.run("ROLLBACK")
        throw error
      }
    })
    await expectFailure(tooMany, join(temp.path, "too-many-restore"))

    const zeroHash = digest(Buffer.alloc(maxFileBytes))
    const tooLarge = await archiveRestore(temp.path, "too-large-total", [], (db) => {
      const insert = db.query("INSERT INTO file VALUES (?, 'file', 384, ?, ?, zeroblob(?))")
      db.run("BEGIN")
      try {
        for (let index = 0; index <= Math.floor(maxTotalBytes / maxFileBytes); index++) {
          insert.run(`large-${index}.bin`, maxFileBytes, zeroHash, maxFileBytes)
        }
        db.run("COMMIT")
      } catch (error) {
        db.run("ROLLBACK")
        throw error
      }
    })
    await expectFailure(tooLarge, join(temp.path, "too-large-total-restore"))
  }, 120_000)

  test(
    "rejects existing destinations without overwriting files, directories or symlinks",
    async () => {
      await using temp = await tmpdir()
      const fixture = await archiveRestore(temp.path, "destination", [file("a.txt", "new")])
      const existingFile = join(temp.path, "existing-file")
      const existingDirectory = join(temp.path, "existing-directory")
      await writeFile(existingFile, "keep")
      await mkdir(existingDirectory)
      await expectFailure(fixture, existingFile)
      expect(await readFile(existingFile, "utf8")).toBe("keep")
      await expectFailure(fixture, existingDirectory)
      expect((await lstat(existingDirectory)).isDirectory()).toBe(true)
    },
    ioTimeout,
  )

  test.skipIf(process.platform === "win32")(
    "rejects destination symlinks without following them",
    async () => {
      await using temp = await tmpdir()
      const fixture = await archiveRestore(temp.path, "destination-symlink", [file("a.txt", "new")])
      const link = join(temp.path, "restore-link")
      const target = join(temp.path, "target")
      await symlink(target, link)

      await expectFailure(fixture, link)

      expect(await exists(target)).toBe(false)
    },
    ioTimeout,
  )

  test("waits for cancelled materialization to settle before cleanup", async () => {
    await using temp = await tmpdir()
    const fixture = await archiveRestore(temp.path, "cancel", [
      dir("project"),
      file("project/000-sentinel.txt", "ready"),
      ...Array.from({ length: 6 }, (_, index) =>
        file(`project/100-large-${index}.bin`, Buffer.alloc(4 * 1024 * 1024, index + 1)),
      ),
    ])
    const before = await readFile(fixture.source)
    const destination = join(temp.path, "cancelled-restore")
    const sentinel = join(destination, "project", "000-sentinel.txt")
    const controller = new AbortController()
    let settled = false
    const running = Effect.runPromise(WorkspaceRestore.materialize({ ...fixture, destination }), {
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
      while (!(await exists(sentinel)) && !settled) {
        if (Date.now() > deadline) throw new Error("restore cancellation fixture did not start")
        await Bun.sleep(5)
      }
      expect(settled).toBe(false)
      controller.abort()
      expect(await running).toBe(false)
      expect(await exists(destination)).toBe(false)
      expect(await readFile(fixture.source)).toEqual(before)
      await Bun.sleep(50)
      expect(await exists(destination)).toBe(false)
    } finally {
      controller.abort()
      await running
    }
  }, 120_000)
})

function dir(path: string, mode = 0o755): Entry {
  return { path, type: "directory", mode }
}

function file(path: string, content: string | Uint8Array, mode = 0o600, parents: string[] = []): Entry[] | Entry {
  const item = {
    path,
    type: "file" as const,
    mode,
    content: typeof content === "string" ? Buffer.from(content) : content,
  }
  return parents.length ? [...parents.map((parent) => dir(parent)), item] : item
}

function raw(row: RawRow) {
  return row
}

async function materialize(fixture: { source: string; expected: DatabaseBackup.Report }, destination: string) {
  return Effect.runPromise(WorkspaceRestore.materialize({ ...fixture, destination }))
}

async function expectFailure(fixture: { source: string; expected: DatabaseBackup.Report }, destination: string) {
  const error = await Effect.runPromise(Effect.flip(WorkspaceRestore.materialize({ ...fixture, destination })))
  expect(error.message).toBe("Workspace файлын сэргээсэн архивыг баталгаажуулж чадсангүй. Өгөгдлийг өөрчлөөгүй.")
}

async function archiveRestore(
  directory: string,
  name: string,
  entries: Array<Entry | Entry[] | RawRow>,
  mutate?: (db: InstanceType<(typeof import("bun:sqlite"))["Database"]>) => void,
) {
  const source = join(directory, `${name}-source.sqlite`)
  const archive = join(directory, `${name}.backup`)
  const restored = join(directory, `${name}-restored.sqlite`)
  const native = await import("bun:sqlite")
  const db = new native.Database(source)
  try {
    db.run(
      "CREATE TABLE file(path TEXT PRIMARY KEY, type TEXT NOT NULL, mode INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT, content BLOB)",
    )
    for (const entry of entries.flat()) insert(db, entry)
    mutate?.(db)
  } finally {
    db.close()
  }
  const key = randomBytes(32)
  const expected = await Effect.runPromise(DatabaseBackup.create({ source, destination: archive, key }))
  expect(await Effect.runPromise(DatabaseBackup.restore({ source: archive, destination: restored, key }))).toEqual(
    expected,
  )
  return { source: restored, expected }
}

function insert(db: InstanceType<(typeof import("bun:sqlite"))["Database"]>, entry: Entry | RawRow) {
  const row = isRawRow(entry)
    ? entry
    : {
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        bytes: entry.type === "file" ? (entry.content?.byteLength ?? 0) : 0,
        sha256: entry.type === "file" ? digest(entry.content ?? Buffer.alloc(0)) : null,
        content: entry.type === "file" ? (entry.content ?? Buffer.alloc(0)) : null,
      }
  db.query("INSERT INTO file VALUES (?, ?, ?, ?, ?, ?)").run(
    row.path,
    row.type,
    row.mode,
    row.bytes,
    row.sha256,
    row.content,
  )
}

function isRawRow(entry: Entry | RawRow): entry is RawRow {
  return "bytes" in entry
}

async function exists(path: string) {
  return lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })
}

async function sidecars(directory: string, name: string) {
  const files = await readdir(directory)
  return files.filter((file) => [`${name}-wal`, `${name}-shm`, `${name}-journal`].includes(file))
}

function digest(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex")
}
