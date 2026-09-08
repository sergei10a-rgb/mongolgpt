export * as CloudBaseline from "./cloud-baseline"

import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdtemp, open, readFile, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import { EffectDrizzleSqlite } from "@mongolgpt/effect-drizzle-sqlite"
import { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { CloudStartup } from "./cloud-startup"
import { DatabaseBackup } from "./backup"
import { DatabaseCheckpoint } from "./checkpoint"
import { WorkspaceCapture } from "./workspace-capture"
import { protectBackupPath } from "./backup-permissions"

const origin = "http://checkpoint.mongolgpt.internal/v1"
const maxUploadBytes = 96 * 1024 * 1024
const Begin = Schema.Struct({
  lease: Schema.Struct({ epoch: Schema.Literal(1), writerID: Schema.String }),
  keyID: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/)),
  key: Schema.String,
})
const Upload = CloudCheckpoint.Archive.mapFields((fields) => ({
  backupID: fields.backupID,
  keyID: fields.keyID,
  bytes: fields.bytes,
  sha256: fields.sha256,
}))
const Receipt = Schema.Struct({ data: CloudCheckpoint.Checkpoint, digest: Schema.String })

export class BaselineError extends Error {
  constructor() {
    super("Шинэ cloud төслийн эхний нөөцийг баталгаажуулж чадсангүй. Серверийг эхлүүлэхгүй.")
    this.name = "CloudBaselineError"
  }
}

/** Root supervisor only, before any tenant process starts. A private native
 * schema is published first; startup must then restore the authenticated pair. */
export async function publish(input: {
  root: string
  request?: (request: Request) => Promise<Response>
  signal?: AbortSignal
}) {
  const root = resolve(input.root)
  const parent = dirname(root)
  const request = input.request ?? fetch
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(110_000)])
  let directory: string | undefined
  let key: Buffer | undefined
  try {
    signal.throwIfAborted()
    if (root !== input.root || root === parent) throw new BaselineError()
    await CloudStartup.pristine(root)
    const writerID = randomUUID()
    const begun = await json(await send("/begin", { writerID }), Begin, signal, 4096)
    if (begun.lease.writerID !== writerID) throw new BaselineError()
    key = Buffer.from(begun.key, "base64")
    if (key.length !== 32 || key.toString("base64") !== begun.key) throw new BaselineError()
    directory = await mkdtemp(join(parent, ".mongolgpt-baseline-"))
    await protectBackupPath(directory, "directory")
    const source = join(directory, "source.sqlite")
    const reserved = await open(source, "wx", 0o600)
    await reserved.close()
    await protectBackupPath(source, "file")
    const sqlite = await import("#sqlite")
    const { DatabaseMigration } = await import("./migration")
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run("PRAGMA synchronous = FULL")
        yield* DatabaseMigration.apply(db)
      }).pipe(Effect.provide(sqlite.layer({ filename: source, disableWAL: true })), Effect.scoped),
      { signal },
    )
    const sqliteArchive = join(directory, "sqlite.mgptbackup")
    const report = await Effect.runPromise(DatabaseBackup.create({ source, destination: sqliteArchive, key }), {
      signal,
    })
    const restored = join(directory, "restored.sqlite")
    await Effect.runPromise(DatabaseBackup.restore({ source: sqliteArchive, destination: restored, key }), { signal })
    const inventory = await Effect.runPromise(DatabaseCheckpoint.inspect({ source: restored, expected: report }), {
      signal,
    })
    if (
      inventory.projects.length ||
      inventory.sessions.length ||
      inventory.aggregates.length ||
      inventory.eventIDs.length ||
      inventory.tombstones.length ||
      !inventory.tombstonesRecorded
    )
      throw new BaselineError()
    const filesArchive = join(directory, "files.mgptbackup")
    const captured = await Effect.runPromise(
      WorkspaceCapture.create({ source: root, destination: filesArchive, key }),
      { signal },
    )
    const checkpoint = Schema.decodeUnknownSync(CloudCheckpoint.Checkpoint)({
      id: randomUUID(),
      inventory,
      sqlite: await upload(sqliteArchive, begun.keyID, report),
      files: await upload(filesArchive, begun.keyID, captured.report),
    })
    await CloudStartup.pristine(root)
    const receipt = await json(await send("/publish", { ...begun.lease, checkpoint }), Receipt, signal, 1024 * 1024)
    if (!isDeepStrictEqual(receipt.data, checkpoint) || !/^[0-9a-f]{64}$/.test(receipt.digest))
      throw new BaselineError()
    signal.throwIfAborted()
    return receipt.data
  } catch {
    throw new BaselineError()
  } finally {
    key?.fill(0)
    if (directory) {
      const inside = relative(parent, directory)
      if (!inside || isAbsolute(inside) || inside.startsWith("..") || !inside.startsWith(".mongolgpt-baseline-"))
        throw new BaselineError()
      await rm(directory, { recursive: true, force: true })
    }
  }

  function send(path: string, body: object) {
    signal.throwIfAborted()
    return interrupted(
      request(
        new Request(`${origin}${path}`, {
          method: "POST",
          redirect: "error",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
      signal,
    )
  }

  async function upload(filename: string, keyID: string, plaintext: { bytes: number; sha256: string }) {
    signal.throwIfAborted()
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxUploadBytes)
      throw new BaselineError()
    const bytes = await readFile(filename)
    try {
      if (bytes.length !== info.size) throw new BaselineError()
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      signal.throwIfAborted()
      const uploaded = await json(
        await interrupted(
          request(
            new Request(`${origin}/upload`, {
              method: "POST",
              redirect: "error",
              signal,
              headers: {
                "content-type": "application/octet-stream",
                "content-length": String(bytes.length),
                "x-mongolgpt-backup-key-id": keyID,
              },
              body: new Uint8Array(bytes).buffer,
            }),
          ),
          signal,
        ),
        Upload,
        signal,
        4096,
      )
      if (uploaded.bytes !== bytes.length || uploaded.sha256 !== sha256 || uploaded.keyID !== keyID)
        throw new BaselineError()
      return { ...uploaded, plaintext: { bytes: plaintext.bytes, sha256: plaintext.sha256 } }
    } finally {
      bytes.fill(0)
    }
  }
}

async function json<A>(response: Response, schema: Schema.Decoder<A>, signal: AbortSignal, limit: number) {
  if (
    response.status !== 200 ||
    response.redirected ||
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => {})
    throw new BaselineError()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let bytes: Buffer | undefined
  try {
    for (;;) {
      const item = await interrupted(reader.read(), signal)
      if (item.done) break
      size += item.value.byteLength
      if (size > limit) throw new BaselineError()
      chunks.push(item.value.slice())
    }
    bytes = Buffer.concat(chunks)
    return Schema.decodeUnknownSync(schema)(
      Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      { onExcessProperty: "error" },
    )
  } finally {
    bytes?.fill(0)
    chunks.forEach((chunk) => chunk.fill(0))
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function interrupted<T>(pending: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = () => cancelled.reject(new BaselineError())
  signal.addEventListener("abort", abort, { once: true })
  try {
    return await Promise.race([pending, cancelled.promise])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}
