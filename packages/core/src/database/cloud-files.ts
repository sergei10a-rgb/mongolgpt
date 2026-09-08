export * as CloudFiles from "./cloud-files"

import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { WorkspaceCapture } from "./workspace-capture"
import { protectBackupPath } from "./backup-permissions"

const origin = "http://checkpoint.mongolgpt.internal/v1"
const maxUploadBytes = 96 * 1024 * 1024
const Integer = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(Number.MAX_SAFE_INTEGER))
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,256}$/))
const Lease = Schema.Struct({ epoch: Integer, writerID: Identifier })
const Bootstrap = Schema.Struct({
  checkpoint: CloudCheckpoint.Checkpoint,
  filesRevision: Schema.optional(CloudCheckpoint.FileRevision),
  keys: Schema.Struct({ sqlite: Schema.String, files: Schema.String }),
})
const Upload = CloudCheckpoint.Archive.mapFields((fields) => ({
  backupID: fields.backupID,
  keyID: fields.keyID,
  bytes: fields.bytes,
  sha256: fields.sha256,
}))
const Receipt = Schema.Struct({ data: CloudCheckpoint.FileRevision, digest: Schema.String })
export type Lease = typeof Lease.Type

export class PublicationError extends Error {
  constructor() {
    super("Cloud файлууд хадгалагдсаныг баталгаажуулж чадсангүй. Өгөгдлийг шалгах хүртэл ажлыг үргэлжлүүлэхгүй.")
    this.name = "CloudFilesPublicationError"
  }
}

/** Root-supervisor only: caller must keep every workspace writer quiesced for
 * this entire operation. No acknowledgement is returned before the R2/D1 receipt. */
export async function publish(input: {
  root: string
  checkpointID: string
  lease: Lease
  signal: AbortSignal
  request?: (request: Request) => Promise<Response>
}) {
  const root = resolve(input.root)
  const checkpointID = input.checkpointID
  const owner = { ...input.lease }
  const request = input.request ?? fetch
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(110_000)])
  let directory: string | undefined
  let key: Buffer | undefined
  let bytes: Buffer | undefined
  try {
    const lease = Schema.decodeUnknownSync(Lease)(owner, { onExcessProperty: "error" })
    if (root !== input.root) throw new PublicationError()
    const bootstrap = await json(await send("/bootstrap", {}), Bootstrap, signal, 1024 * 1024)
    if (bootstrap.checkpoint.id !== checkpointID) throw new PublicationError()
    if (bootstrap.filesRevision && bootstrap.filesRevision.checkpointID !== checkpointID) throw new PublicationError()
    const previous = bootstrap.filesRevision
    const keyID = (previous?.archive ?? bootstrap.checkpoint.files).keyID
    key = Buffer.from(bootstrap.keys.files, "base64")
    if (key.byteLength !== 32 || key.toString("base64") !== bootstrap.keys.files) throw new PublicationError()
    directory = await mkdtemp(join(tmpdir(), "mongolgpt-cloud-files-"))
    await protectBackupPath(directory, "directory")
    const archive = join(directory, "files.mgptbackup")
    const captured = await Effect.runPromise(
      WorkspaceCapture.create({
        source: root,
        destination: archive,
        key,
        exclude: [
          ".mongolgpt/runtime.sqlite",
          ".mongolgpt/runtime.sqlite-wal",
          ".mongolgpt/runtime.sqlite-shm",
          ".mongolgpt/runtime.sqlite-journal",
        ],
      }),
      { signal },
    )
    const info = await lstat(archive)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxUploadBytes)
      throw new PublicationError()
    signal.throwIfAborted()
    bytes = await readFile(archive)
    if (bytes.length !== info.size) throw new PublicationError()
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
      throw new PublicationError()
    const revision = Schema.decodeUnknownSync(CloudCheckpoint.FileRevision)(
      {
        id: randomUUID(),
        checkpointID,
        sequence: (previous?.sequence ?? 0) + 1,
        previousID: previous?.id ?? null,
        archive: { ...uploaded, plaintext: { bytes: captured.report.bytes, sha256: captured.report.sha256 } },
      },
      { onExcessProperty: "error" },
    )
    const receipt = await json(await send("/publish-files", { ...lease, revision }), Receipt, signal, 4096)
    if (!isDeepStrictEqual(receipt.data, revision) || !/^[0-9a-f]{64}$/.test(receipt.digest))
      throw new PublicationError()
    signal.throwIfAborted()
    return receipt
  } catch {
    throw new PublicationError()
  } finally {
    key?.fill(0)
    bytes?.fill(0)
    if (directory) await rm(directory, { recursive: true, force: true })
  }

  function send(path: string, body: object) {
    signal.throwIfAborted()
    return interrupted(
      request(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal,
        }),
      ),
      signal,
    )
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
    throw new PublicationError()
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
      if (size > limit) throw new PublicationError()
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
  const abort = () => cancelled.reject(new PublicationError())
  signal.addEventListener("abort", abort, { once: true })
  try {
    return await Promise.race([pending, cancelled.promise])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}
