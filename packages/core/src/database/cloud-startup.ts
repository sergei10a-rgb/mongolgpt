export * as CloudStartup from "./cloud-startup"

import { createHash } from "node:crypto"
import { lstat, mkdtemp, open, readdir, rename, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { protectBackupPath } from "./backup-permissions"

const origin = "http://checkpoint.mongolgpt.internal"
const envelope = Schema.Union([
  Schema.Struct({ checkpoint: Schema.Null }),
  Schema.Struct({
    checkpoint: CloudCheckpoint.Checkpoint,
    filesRevision: Schema.optional(CloudCheckpoint.FileRevision),
    keys: Schema.Struct({ sqlite: Schema.String, files: Schema.String }),
  }),
])

export class StartupError extends Schema.TaggedErrorClass<StartupError>()("CloudRuntimeStartupError", {
  message: Schema.String,
}) {}

interface Input {
  root: string
  request?: (request: Request) => Promise<Response>
  signal?: AbortSignal
}

/** sqlite/inventory identify the immutable journal baseline, not the latest paired native image. */
export type Baseline = CloudCheckpoint.Checkpoint & { filesRevisionID?: string; resume?: { expectedEpoch?: number } }
let prepared: { checkpoint: Baseline | null; database: string; supervised: boolean } | undefined

/** CLI boundary, before account storage or AppRuntime can open the database. */
export async function prepare(input: Input = { root: "/workspace" }) {
  if (process.env.MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE !== "true") return
  const root = resolve(input.root)
  const database = join(root, ".mongolgpt", "runtime.sqlite")
  if (
    process.env.MONGOLGPT_RUNTIME_MODE !== "hosted" ||
    process.env.MONGOLGPT_CLOUD_HISTORY !== "true" ||
    process.env.MONGOLGPT_DB !== database
  )
    throw unavailable()
  if (prepared) {
    if (prepared.database !== database) throw unavailable()
    return
  }
  const supervised = process.env.MONGOLGPT_RUNTIME_PREPARED_FD !== undefined
  const { StartupHandoff } = await import("./startup-handoff")
  const checkpoint = supervised ? await StartupHandoff.accept(root) : await bootstrap(input)
  // The SDK starts the child inside the old directory inode. Restore the stable
  // working directory after publication; all persisted project paths stay valid.
  process.chdir(root)
  prepared = { checkpoint, database, supervised }
}

export function supervised() {
  baseline()
  return prepared!.supervised
}

export function baseline() {
  if (!prepared || process.env.MONGOLGPT_DB !== prepared.database) throw unavailable()
  return prepared.checkpoint ? structuredClone(prepared.checkpoint) : undefined
}

/** Same-container restart only, after the locked root supervisor has reaped its
 * old cgroup. Preserve the actual native database and all workspace files. */
export async function resume(input: Input & { checkpointID: string; expectedEpoch: number }): Promise<Baseline> {
  const root = resolve(input.root)
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(110_000)])
  const chunks: Uint8Array[] = []
  try {
    if (
      root !== input.root ||
      !Number.isSafeInteger(input.expectedEpoch) ||
      input.expectedEpoch < 1 ||
      input.expectedEpoch >= Number.MAX_SAFE_INTEGER
    )
      throw unavailable()
    for (let current = root; ; current = dirname(current)) {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable()
      if (current === dirname(current)) break
    }
    const home = await lstat(join(root, ".mongolgpt"))
    const database = await lstat(join(root, ".mongolgpt/runtime.sqlite"))
    if (
      !home.isDirectory() ||
      home.isSymbolicLink() ||
      !database.isFile() ||
      database.isSymbolicLink() ||
      database.nlink !== 1 ||
      database.size < 512
    )
      throw unavailable()
    signal.throwIfAborted()
    const response = await aborted(
      (input.request ?? fetch)(
        new Request(`${origin}/v1/bootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          redirect: "error",
          signal,
        }),
      ),
      signal,
    )
    if (
      response.status !== 200 ||
      response.redirected ||
      response.headers.get("content-type")?.split(";")[0].trim() !== "application/json"
    ) {
      void response.body?.cancel().catch(() => {})
      throw unavailable()
    }
    await consume(response, 1024 * 1024, signal, async (chunk) => {
      chunks.push(chunk.slice())
    })
    const data = decodeBootstrap(chunks)
    if (
      !data.checkpoint ||
      data.checkpoint.id !== input.checkpointID ||
      (data.filesRevision && data.filesRevision.checkpointID !== input.checkpointID)
    )
      throw unavailable()
    signal.throwIfAborted()
    return {
      ...data.checkpoint,
      ...(data.filesRevision ? { files: data.filesRevision.archive, filesRevisionID: data.filesRevision.id } : {}),
      resume: { expectedEpoch: input.expectedEpoch },
    }
  } catch {
    throw unavailable()
  } finally {
    chunks.forEach((chunk) => chunk.fill(0))
  }
}

/** Only replaces a pristine container root. Nonempty roots must be checkpointed
 * by the file lifecycle before replacement; never discard uncheckpointed edits.
 */
export async function bootstrap(input: Input): Promise<Baseline | null> {
  const root = resolve(input.root)
  const parent = dirname(root)
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(110_000)])
    : AbortSignal.timeout(110_000)
  const request = input.request ?? fetch
  let scratch: string | undefined
  let preserve = false
  const keys: Uint8Array[] = []
  const chunks: Uint8Array[] = []
  try {
    if (!isAbsolute(input.root) || root === parent) throw new Error()
    await pristine(root)
    const send = async (route: string, body: object) => {
      const response = await aborted(
        request(
          new Request(`${origin}${route}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            redirect: "error",
            signal,
          }),
        ),
        signal,
      )
      if (response.status !== 200 || response.redirected) {
        void response.body?.cancel().catch(() => {})
        throw new Error()
      }
      return response
    }
    const response = await send("/v1/bootstrap", {})
    if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
      void response.body?.cancel().catch(() => {})
      throw new Error()
    }
    await consume(response, 1024 * 1024, signal, async (chunk) => {
      chunks.push(chunk.slice())
    })
    const data = decodeBootstrap(chunks)
    if (!data.checkpoint) {
      await pristine(root)
      signal.throwIfAborted()
      return null
    }
    if (data.filesRevision && data.filesRevision.checkpointID !== data.checkpoint.id) throw new Error()
    const checkpoint = data.filesRevision ? { ...data.checkpoint, files: data.filesRevision.archive } : data.checkpoint
    for (const kind of ["sqlite", "files"] as const) {
      const key = Buffer.from(data.keys[kind], "base64")
      keys.push(key)
      if (key.length !== 32 || key.toString("base64") !== data.keys[kind]) throw new Error()
    }
    scratch = await mkdtemp(join(parent, ".mongolgpt-startup-"))
    await protectBackupPath(scratch, "directory")
    for (const kind of ["sqlite", "files"] as const) {
      const archive = kind === "sqlite" ? (data.filesRevision?.sqlite ?? checkpoint.sqlite) : checkpoint.files
      const response = await send("/v1/archive", {
        checkpointID: checkpoint.id,
        kind,
        filesRevisionID: data.filesRevision?.id,
      })
      if (
        response.headers.get("content-type")?.split(";")[0].trim() !== "application/octet-stream" ||
        response.headers.get("content-length") !== String(archive.bytes)
      ) {
        void response.body?.cancel().catch(() => {})
        throw new Error()
      }
      const filename = join(scratch, `${kind}.mgptbackup`)
      const file = await open(filename, "wx", 0o600)
      try {
        await protectBackupPath(filename, "file")
        const hash = createHash("sha256")
        const bytes = await consume(response, archive.bytes, signal, async (chunk) => {
          hash.update(chunk)
          for (let offset = 0; offset < chunk.length; ) {
            const written = await file.write(chunk.subarray(offset))
            if (!written.bytesWritten) throw new Error()
            offset += written.bytesWritten
          }
        })
        if (bytes !== archive.bytes || hash.digest("hex") !== archive.sha256) throw new Error()
        await file.sync()
      } finally {
        await file.close()
        void response.body?.cancel().catch(() => {})
      }
    }
    // Keep heavyweight native layers out of the pre-runtime module's imports.
    const { CloudRestore } = await import("./cloud-restore")
    const restored = await Effect.runPromise(
      CloudRestore.restore({
        parent: scratch,
        checkpoint,
        revision: data.filesRevision,
        sqlite: { source: join(scratch, "sqlite.mgptbackup"), key: keys[0] },
        files: { source: join(scratch, "files.mgptbackup"), key: keys[1] },
      }),
      { signal },
    )
    await pristine(root)
    signal.throwIfAborted()
    const previous = join(scratch, "empty-root")
    // Publication cannot be interrupted between the two renames. A failure
    // restores the old root, or retains both generations for explicit recovery.
    await rename(root, previous)
    preserve = true
    try {
      await pristine(previous)
      await rename(restored.directory, root)
      preserve = false
    } catch (error) {
      await rename(previous, root)
      preserve = false
      throw error
    }
    return data.filesRevision
      ? { ...checkpoint, filesRevisionID: data.filesRevision.id, ...(data.filesRevision.sqlite ? { resume: {} } : {}) }
      : checkpoint
  } catch {
    throw unavailable()
  } finally {
    keys.forEach((key) => key.fill(0))
    chunks.forEach((chunk) => chunk.fill(0))
    if (scratch && !preserve) {
      const inside = relative(parent, scratch)
      if (!inside || isAbsolute(inside) || inside.startsWith("..") || !inside.startsWith(".mongolgpt-startup-"))
        throw unavailable()
      await rm(scratch, { recursive: true, force: true })
    }
  }
}

export async function pristine(root: string) {
  for (let current = root; ; current = dirname(current)) {
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error()
    if (current === dirname(current)) break
  }
  const pending = [root]
  let count = 0
  while (pending.length) {
    const directory = pending.pop()!
    for (const name of await readdir(directory)) {
      if (++count > 256 || (directory === root && name !== ".mongolgpt")) throw new Error()
      if (directory === join(root, ".mongolgpt") && !["data", "config", "cache", "state"].includes(name))
        throw new Error()
      const filename = join(directory, name)
      const info = await lstat(filename)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error()
      pending.push(filename)
    }
  }
}

async function consume(
  response: Response,
  limit: number,
  signal: AbortSignal,
  write: (chunk: Uint8Array) => Promise<void>,
) {
  if (!response.body) throw new Error()
  const reader = response.body.getReader()
  let bytes = 0
  try {
    while (true) {
      const next = await aborted(reader.read(), signal)
      if (next.done) return bytes
      bytes += next.value.byteLength
      if (bytes > limit) throw new Error()
      await write(next.value)
    }
  } finally {
    void reader
      .cancel()
      .catch(() => {})
      .finally(() => reader.releaseLock())
  }
}

function decodeBootstrap(chunks: Uint8Array[]) {
  const bytes = Buffer.concat(chunks)
  try {
    return Schema.decodeUnknownSync(envelope)(
      Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(bytes.toString("utf8")),
      { onExcessProperty: "error" },
    )
  } finally {
    bytes.fill(0)
    chunks.forEach((chunk) => chunk.fill(0))
  }
}

async function aborted<T>(pending: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted()
  const cancel = Promise.withResolvers<never>()
  const abort = () => cancel.reject(new Error("Startup interrupted"))
  signal.addEventListener("abort", abort, { once: true })
  try {
    return await Promise.race([pending, cancel.promise])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

function unavailable() {
  return new StartupError({
    message: "Cloud ажлын талбарыг аюулгүй сэргээж чадсангүй. Өгөгдлийг шалгах хүртэл серверийг эхлүүлэхгүй.",
  })
}
