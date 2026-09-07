export * as WorkspaceRestore from "./workspace-restore"

import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { Effect, Schema } from "effect"
import { protectBackupPath } from "./backup-permissions"
import { DatabaseBackup } from "./backup"
import { Sqlite } from "./sqlite"

export class RestoreError extends Schema.TaggedErrorClass<RestoreError>()("WorkspaceRestoreError", {
  message: Schema.String,
}) {}

export interface Summary {
  files: number
  directories: number
  bytes: number
}

interface Input {
  source: string
  expected: DatabaseBackup.Report
  destination: string
}

interface Entry {
  path: string
  type: "file" | "directory"
  mode: number
  bytes: number
  sha256: string | null
}

interface Created {
  files: string[]
  directories: string[]
}

type NativeStatement = {
  all: (...params: unknown[]) => unknown[]
  get: (...params: unknown[]) => unknown
  finalize?: () => void
  safeIntegers?: (value: boolean) => void
  setReadBigInts?: (value: boolean) => void
}

type NativeDatabase = {
  exec: (query: string) => void
  prepare?: (query: string) => NativeStatement
  query?: (query: string) => NativeStatement
}

const maxFileBytes = 8 * 1024 * 1024
const maxTotalBytes = 64 * 1024 * 1024
const maxEntries = 10_000
const maxPathBytes = 4096
const maxComponentBytes = 255
const chunkBytes = 128 * 1024
const reservedWindowsNames = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
  ...["¹", "²", "³"].flatMap((digit) => [`COM${digit}`, `LPT${digit}`]),
])

/** Materializes a verified workspace file archive into a new private directory.
 *
 * Initial bounded restore limits are deliberate and fail closed: at most 10,000
 * entries, 8 MiB per file and 64 MiB of file content total. The source format is
 * the diagnostic helper's `file(path,type,mode,bytes,sha256,content)` table.
 */
export function materialize(input: Input) {
  return operation(async (signal) => {
    const source = resolve(input.source)
    const destination = resolve(input.destination)
    const created: Created = { files: [], directories: [] }
    try {
      const receipt = await Effect.runPromise(DatabaseBackup.verify({ source, expected: input.expected }), { signal })
      await assertNewDestination(destination)
      await createDirectory(destination, created)
      const summary = await readArchive(source, destination, created, signal)
      await Effect.runPromise(DatabaseBackup.verify({ source, expected: receipt }), { signal })
      return summary
    } catch (error) {
      await cleanup(created)
      throw error
    }
  })
}

function operation<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.callback<A, RestoreError>((resume, signal) => {
    const pending = run(signal).then(
      (result) => resume(Effect.succeed(result)),
      () =>
        resume(
          Effect.fail(
            new RestoreError({
              message: "Workspace файлын сэргээсэн архивыг баталгаажуулж чадсангүй. Өгөгдлийг өөрчлөөгүй.",
            }),
          ),
        ),
    )
    return Effect.promise(() => pending)
  })
}

async function readArchive(source: string, destination: string, created: Created, signal: AbortSignal) {
  const sqlite = await import("#sqlite")
  return Effect.runPromise(
    Effect.gen(function* () {
      const native = (yield* Sqlite.Native) as NativeDatabase
      return yield* consumeEffect(native, destination, created)
    }).pipe(
      Effect.provide(
        sqlite.layer({ filename: source, readonly: true, readwrite: false, create: false, disableWAL: true }),
      ),
      Effect.scoped,
    ),
    { signal },
  )
}

function consumeEffect(native: NativeDatabase, destination: string, created: Created) {
  return Effect.callback<Summary, unknown>((resume, signal) => {
    const pending = consume(native, destination, created, signal).then(
      (result) => resume(Effect.succeed(result)),
      (error) => resume(Effect.fail(error)),
    )
    return Effect.promise(() =>
      pending.then(
        () => undefined,
        () => undefined,
      ),
    )
  })
}

async function consume(native: NativeDatabase, destination: string, created: Created, signal: AbortSignal) {
  native.exec("PRAGMA trusted_schema = OFF")
  native.exec("PRAGMA query_only = ON")
  const entries = validateEntries(readMetadata(native))
  for (const entry of entries.filter((entry) => entry.type === "directory")) {
    signal.throwIfAborted()
    await createDirectory(targetPath(destination, entry.path), created)
  }
  for (const entry of entries.filter((entry) => entry.type === "file")) {
    signal.throwIfAborted()
    const content = readContent(native, entry)
    try {
      if (content.byteLength !== entry.bytes || digest(content) !== entry.sha256) throw invalid()
      const target = targetPath(destination, entry.path)
      await privateFile(target, content, created)
      if ((await hashFile(target, signal)) !== entry.sha256) throw invalid()
      if (process.platform !== "win32") await chmod(target, entry.mode & 0o100 ? 0o700 : 0o600)
    } finally {
      content.fill(0)
    }
  }
  return {
    files: entries.filter((entry) => entry.type === "file").length,
    directories: entries.filter((entry) => entry.type === "directory").length,
    bytes: entries.reduce((total, entry) => total + (entry.type === "file" ? entry.bytes : 0), 0),
  } satisfies Summary
}

function readMetadata(native: NativeDatabase) {
  const table = all<{ type: string }>(
    native,
    "SELECT type FROM sqlite_schema WHERE name = 'file' AND tbl_name = 'file'",
  )
  if (table.length !== 1 || table[0].type !== "table") throw invalid()
  const columns = all<{ name: string; type: string; notnull: number; pk: number }>(native, "PRAGMA table_info('file')")
  const expected = [
    ["path", "TEXT", 0, 1],
    ["type", "TEXT", 1, 0],
    ["mode", "INTEGER", 1, 0],
    ["bytes", "INTEGER", 1, 0],
    ["sha256", "TEXT", 0, 0],
    ["content", "BLOB", 0, 0],
  ] as const
  if (
    columns.length !== expected.length ||
    expected.some(([name, type, notnull, pk], index) => {
      const column = columns[index]
      return (
        !column ||
        column.name !== name ||
        column.type.toUpperCase() !== type ||
        column.notnull !== notnull ||
        column.pk !== pk
      )
    })
  )
    throw invalid()
  const count = one<{ count: number }>(native, "SELECT count(*) AS count FROM file").count
  if (!Number.isSafeInteger(count) || count < 0 || count > maxEntries) throw invalid()
  if (
    get(
      native,
      `SELECT 1 FROM file WHERE
      typeof(path) != 'text' OR length(CAST(path AS BLOB)) < 1 OR length(CAST(path AS BLOB)) > ${maxPathBytes}
      OR typeof(type) != 'text' OR type NOT IN ('file','directory')
      OR typeof(mode) != 'integer' OR mode < 0 OR mode > 511
      OR typeof(bytes) != 'integer' OR bytes < 0 OR bytes > ${maxFileBytes}
      OR (type = 'directory' AND (bytes != 0 OR sha256 IS NOT NULL OR content IS NOT NULL))
      OR (type = 'file' AND (
        typeof(sha256) != 'text' OR length(sha256) != 64 OR sha256 GLOB '*[^0-9a-f]*'
        OR typeof(content) != 'blob' OR length(content) != bytes
      ))
      LIMIT 1`,
    )
  )
    throw invalid()
  const total = one<{ total: number }>(
    native,
    "SELECT coalesce(sum(bytes), 0) AS total FROM file WHERE type = 'file'",
  ).total
  if (!Number.isSafeInteger(total) || total < 0 || total > maxTotalBytes) throw invalid()
  return all<Entry>(native, "SELECT path, type, mode, bytes, sha256 FROM file ORDER BY path")
}

function validateEntries(entries: Entry[]) {
  const paths = new Set<string>()
  const casefold = new Set<string>()
  const directories = new Set<string>()
  for (const entry of entries) {
    validatePath(entry.path)
    if (paths.has(entry.path)) throw invalid()
    paths.add(entry.path)
    const folded = entry.path.toLowerCase()
    if (process.platform === "win32" && casefold.has(folded)) throw invalid()
    casefold.add(folded)
    const parent = parentPath(entry.path)
    if (parent && !directories.has(parent)) throw invalid()
    if (entry.type === "directory") directories.add(entry.path)
  }
  return [...entries].sort(
    (a, b) =>
      depth(a.path) - depth(b.path) ||
      (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) ||
      a.path.localeCompare(b.path),
  )
}

function validatePath(path: string) {
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.includes(":") ||
    /[<>"|?*]/.test(path) ||
    /[\x00-\x1f\x7f]/.test(path) ||
    Buffer.byteLength(path) > maxPathBytes
  )
    throw invalid()
  for (const component of path.split("/")) {
    if (
      !component ||
      component === "." ||
      component === ".." ||
      component.endsWith(" ") ||
      component.endsWith(".") ||
      Buffer.byteLength(component) > maxComponentBytes
    )
      throw invalid()
    const stem = component.split(".")[0].toUpperCase()
    if (reservedWindowsNames.has(stem)) throw invalid()
  }
}

function readContent(native: NativeDatabase, entry: Entry) {
  const row = one<{ content: Uint8Array }>(native, "SELECT content FROM file WHERE path = ?", entry.path)
  if (!(row.content instanceof Uint8Array)) throw invalid()
  return row.content
}

async function assertNewDestination(destination: string) {
  await assertAbsent(destination)
  for (let current = dirname(destination); current !== dirname(current); current = dirname(current)) {
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid()
  }
}

async function createDirectory(path: string, created: Created) {
  await assertAbsent(path)
  await mkdir(path, { mode: 0o700 })
  created.directories.push(path)
  await protectBackupPath(path, "directory")
}

async function privateFile(path: string, content: Uint8Array, created: Created) {
  await assertParentDirectory(path)
  const file = await open(path, "wx", 0o600)
  created.files.push(path)
  try {
    await protectBackupPath(path, "file")
    await file.writeFile(content)
    await file.sync()
  } finally {
    await file.close()
  }
}

async function assertParentDirectory(path: string) {
  const info = await lstat(dirname(path))
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid()
}

async function assertAbsent(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (info) throw invalid()
}

function targetPath(destination: string, path: string) {
  const target = resolve(destination, ...path.split("/"))
  const root = destination.endsWith(sep) ? destination : destination + sep
  const actual = process.platform === "win32" ? target.toLowerCase() : target
  const expected = process.platform === "win32" ? root.toLowerCase() : root
  if (!actual.startsWith(expected)) throw invalid()
  return target
}

async function hashFile(path: string, signal: AbortSignal) {
  const hash = createHash("sha256")
  await withFile(path, "r", async (file) => {
    const size = (await file.stat()).size
    const buffer = Buffer.alloc(chunkBytes)
    for (let position = 0; position < size; ) {
      signal.throwIfAborted()
      const read = await file.read(buffer, 0, Math.min(buffer.length, size - position), position)
      if (!read.bytesRead) throw invalid()
      hash.update(buffer.subarray(0, read.bytesRead))
      position += read.bytesRead
    }
  })
  return hash.digest("hex")
}

async function cleanup(created: Created) {
  for (const file of created.files.reverse()) {
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
  for (const directory of created.directories.reverse()) {
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

async function withFile<A>(path: string, flags: string, run: (file: FileHandle) => Promise<A>) {
  const file = await open(path, flags)
  try {
    return await run(file)
  } finally {
    await file.close()
  }
}

function all<A>(native: NativeDatabase, query: string, ...params: unknown[]) {
  const statement = prepare(native, query)
  try {
    return statement.all(...params) as A[]
  } finally {
    statement.finalize?.()
  }
}

function get<A>(native: NativeDatabase, query: string, ...params: unknown[]) {
  const statement = prepare(native, query)
  try {
    return statement.get(...params) as A | undefined
  } finally {
    statement.finalize?.()
  }
}

function one<A>(native: NativeDatabase, query: string, ...params: unknown[]) {
  const row = get<A>(native, query, ...params)
  if (!row) throw invalid()
  return row
}

function prepare(native: NativeDatabase, query: string) {
  const statement = native.prepare?.(query) ?? native.query?.(query)
  if (!statement) throw invalid()
  statement.safeIntegers?.(false)
  statement.setReadBigInts?.(false)
  return statement
}

function depth(path: string) {
  return path.split("/").length
}

function parentPath(path: string) {
  const index = path.lastIndexOf("/")
  return index < 0 ? "" : path.slice(0, index)
}

function digest(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex")
}

function invalid() {
  return new Error("Invalid workspace restore archive")
}
