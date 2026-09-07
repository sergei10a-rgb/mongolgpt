export * as WorkspaceCapture from "./workspace-capture"

import { createHash } from "node:crypto"
import { constants } from "node:fs"
import type { Stats } from "node:fs"
import { lstat, mkdtemp, open, readdir, rm, link } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { Effect, Schema } from "effect"
import { DatabaseBackup } from "./backup"
import { protectBackupPath } from "./backup-permissions"
import { Sqlite } from "./sqlite"
import { WorkspaceRestore } from "./workspace-restore"

export class CaptureError extends Schema.TaggedErrorClass<CaptureError>()("WorkspaceCaptureError", {
  message: Schema.String,
}) {}

export interface Input {
  source: string
  destination: string
  key: Uint8Array
  exclude?: readonly string[]
}

interface Entry {
  path: string
  type: "file" | "directory"
  mode: number
  bytes: number
  sha256: string | null
  content?: Buffer
}

interface Inventory {
  entries: Entry[]
  summary: WorkspaceRestore.Summary
}

interface State {
  source: string
  root: Identity
  exclude: ReadonlySet<string>
  signal: AbortSignal
  includeContent: boolean
  entries: Entry[]
  owned: Buffer[]
  files: number
  directories: number
  bytes: number
}

interface Identity {
  dev: number
  ino: number
  mode: number
}

type NativeStatement = {
  run: (...params: unknown[]) => unknown
  finalize?: () => void
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

/** Captures a caller-quiesced workspace into an encrypted native file archive.
 *
 * The caller must stop background workspace writes before invoking this. Capture
 * detects common races by rereading metadata, hashes and the final inventory, but
 * it cannot make a live tree transactional; revision CAS is handled by the
 * publication layer above this bounded native snapshot.
 */
export function create(input: Input) {
  return operation(async (signal) => {
    const paths = await validateInput(input)
    const key = Buffer.from(input.key)
    try {
      signal.throwIfAborted()
      return await staging(paths.destination, async (directory) => {
        const manifest = join(directory, "workspace.sqlite")
        const archive = join(directory, "workspace.archive")
        const restored = join(directory, "workspace-restored.sqlite")
        const verification = join(directory, "workspace-restore")
        await withFile(manifest, "wx", async () => {})
        await protectBackupPath(manifest, "file")
        const inventory = await capture(paths.source, paths.exclude, signal)
        try {
          await writeArchive(manifest, inventory.entries, signal)
        } finally {
          inventory.entries.forEach((entry) => entry.content?.fill(0))
        }
        if (!sameInventory(inventory, await capture(paths.source, paths.exclude, signal, false))) throw invalid()
        const report = await Effect.runPromise(DatabaseBackup.create({ source: manifest, destination: archive, key }), {
          signal,
        })
        await Effect.runPromise(DatabaseBackup.restore({ source: archive, destination: restored, key }), { signal })
        const summary = await Effect.runPromise(
          WorkspaceRestore.materialize({ source: restored, expected: report, destination: verification }),
          { signal },
        )
        if (JSON.stringify(summary) !== JSON.stringify(inventory.summary)) throw invalid()
        signal.throwIfAborted()
        await assertAbsent(paths.destination)
        await publish(archive, paths.destination)
        return { report, summary }
      })
    } finally {
      key.fill(0)
    }
  })
}

function operation<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.callback<A, CaptureError>((resume, signal) => {
    const pending = run(signal).then(
      (result) => resume(Effect.succeed(result)),
      (error) =>
        resume(
          Effect.fail(
            error instanceof CaptureError
              ? error
              : new CaptureError({
                  message: "Ажлын талбарын агшинг үүсгэж чадсангүй. Эх өгөгдлийг өөрчлөөгүй.",
                }),
          ),
        ),
    )
    return Effect.promise(() => pending)
  })
}

async function validateInput(input: Input) {
  if (input.key.byteLength !== 32)
    throw new CaptureError({ message: "Ажлын талбарын агшингийн шифрлэлтийн түлхүүр 32 байт байх ёстой." })
  if (hasTraversal(input.source) || hasTraversal(input.destination)) throw invalid()
  const source = resolve(input.source)
  const destination = resolve(input.destination)
  await assertAncestors(source)
  await assertAncestors(dirname(destination))
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw invalid()
  if (insideOrSame(destination, source)) throw invalid()
  await assertAbsent(destination)
  return { source, destination, exclude: validateExclude(input.exclude ?? []) }
}

function validateExclude(exclude: readonly string[]) {
  return new Set(
    exclude.map((path) => {
      validatePortablePath(path)
      return path
    }),
  )
}

async function capture(source: string, exclude: ReadonlySet<string>, signal: AbortSignal, includeContent = true) {
  const root = await lstat(source)
  if (!root.isDirectory() || root.isSymbolicLink()) throw invalid()
  const state: State = {
    source,
    root: identity(root),
    exclude,
    signal,
    includeContent,
    entries: [],
    owned: [],
    files: 0,
    directories: 0,
    bytes: 0,
  }
  try {
    await scanDirectory(state, source, "", identity(root))
    return {
      entries: sortEntries(state.entries),
      summary: { files: state.files, directories: state.directories, bytes: state.bytes },
    } satisfies Inventory
  } catch (error) {
    state.owned.forEach((buffer) => buffer.fill(0))
    throw error
  }
}

async function scanDirectory(state: State, directory: string, prefix: string, expected: Identity) {
  state.signal.throwIfAborted()
  await assertRoot(state)
  const before = await lstat(directory)
  if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(expected, identity(before))) throw invalid()
  const children = (await readdir(directory)).sort()
  const afterList = await lstat(directory)
  if (!afterList.isDirectory() || afterList.isSymbolicLink() || !sameIdentity(identity(before), identity(afterList)))
    throw invalid()
  for (const name of children) {
    state.signal.throwIfAborted()
    await scanChild(state, directory, name, prefix, identity(before))
  }
  const after = await lstat(directory)
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(identity(before), identity(after)))
    throw invalid()
  await assertRoot(state)
}

async function scanChild(state: State, directory: string, name: string, prefix: string, parent: Identity) {
  const archivePath = prefix ? `${prefix}/${name}` : name
  validatePortablePath(archivePath)
  const nativePath = join(directory, name)
  const info = await lstat(nativePath)
  await assertRoot(state)
  await assertDirectoryIdentity(directory, parent)
  if (info.isSymbolicLink()) throw invalid()
  if (info.isDirectory()) {
    if (state.exclude.has(archivePath)) throw invalid()
    reserveDirectory(state)
    state.entries.push({ path: archivePath, type: "directory", mode: mode(info), bytes: 0, sha256: null })
    await scanDirectory(state, nativePath, archivePath, identity(info))
    return
  }
  if (!info.isFile()) throw invalid()
  if (state.exclude.has(archivePath)) return
  if (info.nlink > 1) throw invalid()
  reserveFile(state, info.size)
  state.entries.push(await scanFile(state, nativePath, archivePath, info))
}

async function scanFile(state: State, nativePath: string, archivePath: string, info: Stats) {
  const content = state.includeContent ? Buffer.alloc(info.size) : undefined
  if (content) state.owned.push(content)
  try {
    const sha256 = content
      ? await readFile(nativePath, info, content, state.signal)
      : await hashFile(nativePath, info, state.signal)
    const after = await lstat(nativePath)
    if (!sameFile(info, after)) throw invalid()
    if ((await hashFile(nativePath, after, state.signal)) !== sha256) throw invalid()
    await assertRoot(state)
    return { path: archivePath, type: "file" as const, mode: mode(info), bytes: info.size, sha256, content }
  } catch (error) {
    content?.fill(0)
    throw error
  }
}

function reserveDirectory(state: State) {
  if (state.files + state.directories + 1 > maxEntries) throw invalid()
  state.directories++
}

function reserveFile(state: State, bytes: number) {
  if (bytes > maxFileBytes || state.files + state.directories + 1 > maxEntries || state.bytes + bytes > maxTotalBytes)
    throw invalid()
  state.files++
  state.bytes += bytes
}

async function writeArchive(filename: string, entries: Entry[], signal: AbortSignal) {
  const sqlite = await import("#sqlite")
  await Effect.runPromise(
    Effect.gen(function* () {
      const native = (yield* Sqlite.Native) as NativeDatabase
      native.exec("PRAGMA trusted_schema = OFF")
      native.exec("PRAGMA synchronous = FULL")
      native.exec(
        "CREATE TABLE file(path TEXT PRIMARY KEY, type TEXT NOT NULL, mode INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT, content BLOB)",
      )
      native.exec("BEGIN IMMEDIATE")
      try {
        const statement = prepare(native, "INSERT INTO file VALUES (?, ?, ?, ?, ?, ?)")
        try {
          for (const entry of entries) {
            signal.throwIfAborted()
            statement.run(entry.path, entry.type, entry.mode, entry.bytes, entry.sha256, entry.content ?? null)
          }
        } finally {
          statement.finalize?.()
        }
        native.exec("COMMIT")
      } catch (error) {
        native.exec("ROLLBACK")
        throw error
      }
    }).pipe(
      Effect.provide(sqlite.layer({ filename, readwrite: true, create: false, disableWAL: true })),
      Effect.scoped,
    ),
    { signal },
  )
}

async function staging<A>(destination: string, run: (directory: string) => Promise<A>) {
  const directory = await mkdtemp(join(dirname(destination), ".mongolgpt-workspace-capture-"))
  try {
    await protectBackupPath(directory, "directory")
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {
      throw new CaptureError({ message: "Ажлын талбарын агшингийн түр файлуудыг цэвэрлэж чадсангүй." })
    })
  }
}

async function publish(source: string, destination: string) {
  await withFile(source, "r+", (file) => file.sync())
  await link(source, destination)
  if (process.platform !== "win32") await withFile(dirname(destination), "r", (file) => file.sync())
}

async function readFile(path: string, info: Stats, content: Buffer, signal: AbortSignal) {
  const hash = createHash("sha256")
  await withFile(path, readFlags(), async (file) => {
    if (!sameFile(info, await file.stat())) throw invalid()
    for (let position = 0; position < info.size; ) {
      signal.throwIfAborted()
      const read = await file.read(content, position, Math.min(chunkBytes, info.size - position), position)
      if (!read.bytesRead) throw invalid()
      hash.update(content.subarray(position, position + read.bytesRead))
      position += read.bytesRead
    }
    if (!sameFile(info, await file.stat())) throw invalid()
  })
  return hash.digest("hex")
}

async function hashFile(path: string, info: Stats, signal: AbortSignal) {
  const hash = createHash("sha256")
  await withFile(path, readFlags(), async (file) => {
    if (!sameFile(info, await file.stat())) throw invalid()
    const buffer = Buffer.alloc(Math.min(chunkBytes, Math.max(info.size, 1)))
    try {
      for (let position = 0; position < info.size; ) {
        signal.throwIfAborted()
        const read = await file.read(buffer, 0, Math.min(buffer.length, info.size - position), position)
        if (!read.bytesRead) throw invalid()
        hash.update(buffer.subarray(0, read.bytesRead))
        position += read.bytesRead
      }
    } finally {
      buffer.fill(0)
    }
    if (!sameFile(info, await file.stat())) throw invalid()
  })
  return hash.digest("hex")
}

async function withFile<A>(path: string, flags: string | number, run: (file: FileHandle) => Promise<A>) {
  const file = await open(path, flags, 0o600)
  try {
    return await run(file)
  } finally {
    await file.close()
  }
}

async function assertRoot(state: State) {
  await assertDirectoryIdentity(state.source, state.root)
}

async function assertDirectoryIdentity(path: string, expected: Identity) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || !sameIdentity(expected, identity(info))) throw invalid()
}

async function assertAncestors(path: string) {
  for (let current = path; current !== dirname(current); current = dirname(current)) {
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid()
  }
}

async function assertAbsent(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (info) throw invalid()
}

function prepare(native: NativeDatabase, query: string) {
  const statement = native.prepare?.(query) ?? native.query?.(query)
  if (!statement) throw invalid()
  return statement
}

function sameInventory(left: Inventory, right: Inventory) {
  return JSON.stringify(stripContent(left)) === JSON.stringify(stripContent(right))
}

function stripContent(inventory: Inventory) {
  return {
    entries: inventory.entries.map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
    summary: inventory.summary,
  }
}

function sortEntries(entries: Entry[]) {
  return [...entries].sort(
    (a, b) =>
      depth(a.path) - depth(b.path) ||
      (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) ||
      a.path.localeCompare(b.path),
  )
}

function validatePortablePath(path: string) {
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

function sameFile(before: Stats, after: Stats) {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    before.size === after.size &&
    mode(before) === mode(after) &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.dev === after.dev &&
    before.ino === after.ino
  )
}

function sameIdentity(left: Identity, right: Identity) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

function identity(info: Stats) {
  return { dev: info.dev, ino: info.ino, mode: mode(info) }
}

function mode(info: Stats) {
  return info.mode & 0o777
}

function depth(path: string) {
  return path.split("/").length
}

function insideOrSame(path: string, parent: string) {
  const actual = process.platform === "win32" ? path.toLowerCase() : path
  const expected = process.platform === "win32" ? parent.toLowerCase() : parent
  return actual === expected || actual.startsWith(expected.endsWith(sep) ? expected : expected + sep)
}

function hasTraversal(path: string) {
  return path.split(/[\\/]+/).includes("..")
}

function readFlags() {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
}

function invalid() {
  return new CaptureError({ message: "Ажлын талбарын агшингийн эх, зорилтот зам эсвэл архивын бүтэц буруу байна." })
}
