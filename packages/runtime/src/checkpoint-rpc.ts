import { Buffer } from "node:buffer"
import { Schema } from "effect"
import {
  checkpointControlHeader,
  deriveCheckpointControlToken,
  matchesControlToken,
} from "@mongolgpt/runtime-auth/control"
import { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { createRuntimeBackupStore, deriveRuntimeBackupKey, RuntimeBackupError } from "./backup"
import { createRuntimeCheckpointStore } from "./checkpoint"
import { decodeCheckpoint, decodeFileRevision } from "./checkpoint-contract"
import { createHistoryStore, HistoryError, type HistoryLease, type HistoryScope } from "./history"

const origin = "http://checkpoint.mongolgpt.internal"
const maxBodyBytes = 4096
const maxCheckpointBodyBytes = 1024 * 1024
const maxSecretBytes = 32 * 1024
const bodyTimeoutMs = 5000
const maxUploadBytes = 96 * 1024 * 1024
const uploadTimeoutMs = 110_000
const decoder = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()
const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const
const streamHeaders = {
  "cache-control": "no-store",
  "content-type": "application/octet-stream",
} as const
const safeMessages = {
  forbidden: "Cloud checkpoint эрх баталгаажаагүй байна.",
  invalid: "Cloud checkpoint хүсэлт буруу байна.",
  conflict: "Cloud checkpoint-ийн төлөв зөрсөн байна. Сессийг дахин ачаална уу.",
  unavailable: "Cloud checkpoint үйлчилгээнд холбогдож чадсангүй.",
} as const
const statuses = {
  forbidden: 403,
  invalid: 400,
  conflict: 409,
  unavailable: 503,
} as const

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,256}$/))
const UUID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const ScopeInput = Schema.Struct({ accountID: Identifier, workspaceID: Identifier })
const BootstrapInput = Schema.Struct({})
const BeginInput = Schema.Struct({ writerID: Identifier })
const ArchiveInput = Schema.Struct({
  checkpointID: UUID,
  kind: Schema.Union([Schema.Literal("sqlite"), Schema.Literal("files")]),
  filesRevisionID: Schema.optional(UUID),
})
const PublishInput = Schema.Struct({
  epoch: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  writerID: Identifier,
  checkpoint: Schema.Unknown,
})
const PublishFilesInput = Schema.Struct({
  epoch: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  writerID: Identifier,
  revision: CloudCheckpoint.FileRevision,
})
const BackupKeyID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/))
const UploadReceipt = Schema.Struct({
  backupID: UUID,
  keyID: BackupKeyID,
  bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maxUploadBytes)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
})

type CheckpointRecord = { data: CloudCheckpoint.Checkpoint; digest?: string }
type HistoryStore = Pick<ReturnType<typeof createHistoryStore>, "checkpoint" | "epoch" | "claim" | "fileRevision">
type ArchiveManifest = {
  version: number
  format: string
  backupID: string
  keyID: string
  bytes: number
  sha256: string
}
type StreamReadResult = ReadableStreamDefaultReadDoneResult | ReadableStreamDefaultReadValueResult<Uint8Array>
type BackupStore = {
  open(scope: HistoryScope, backupID: string): Promise<{ manifest: ArchiveManifest; body: ReadableStream<Uint8Array> }>
  save?: ReturnType<typeof createRuntimeBackupStore>["save"]
}
type CheckpointStores = {
  history: HistoryStore
  backups?: BackupStore
  publisher?: Partial<Pick<ReturnType<typeof createRuntimeCheckpointStore>, "publish" | "publishFiles">>
  masterKeyJson?: string
  bodyTimeoutMs?: number
  uploadTimeoutMs?: number
}

class CheckpointRpcError extends Error {
  constructor(readonly code: keyof typeof safeMessages) {
    super(safeMessages[code])
    this.name = "CheckpointRpcError"
  }
}

export async function handleCheckpointOutbound(
  request: Request,
  env: {
    HISTORY?: D1Database
    RUNTIME_BACKUPS?: R2Bucket
    MONGOLGPT_RUNTIME_BACKUP_KEYS?: string
    MONGOLGPT_RUNTIME_SECRET?: string
  },
  context: { params?: unknown },
): Promise<Response> {
  let masters: Record<string, Uint8Array> | undefined
  try {
    const trustedScope = Object.freeze({ ...(decode(ScopeInput, context.params) as typeof ScopeInput.Type) })
    const expected = await deriveCheckpointControlToken(env.MONGOLGPT_RUNTIME_SECRET ?? "", trustedScope)
    if (!matchesControlToken(request.headers.get(checkpointControlHeader), expected)) return failure("forbidden")

    const db = env.HISTORY
    const bucket = env.RUNTIME_BACKUPS
    const masterKeyJson = env.MONGOLGPT_RUNTIME_BACKUP_KEYS
    if (!db) return failure("unavailable")
    return await createCheckpointHandler(
      {
        history: createHistoryStore(db),
        backups: bucket ? createRuntimeBackupStore(bucket) : undefined,
        publisher: bucket
          ? {
              async publish(lease, checkpoint) {
                masters = readMasterKeys(masterKeyJson)
                return createRuntimeCheckpointStore(db, bucket, masters).publish(lease, checkpoint)
              },
              async publishFiles(lease, revision) {
                masters = readMasterKeys(masterKeyJson)
                return createRuntimeCheckpointStore(db, bucket, masters).publishFiles(lease, revision)
              },
            }
          : undefined,
        masterKeyJson,
      },
      trustedScope,
    )(request)
  } catch {
    return failure("unavailable")
  } finally {
    // Publication may still be authenticating an archive after request abort.
    // Its master keys belong to the awaited operation, not the response race.
    if (masters) Object.values(masters).forEach((master) => master.fill(0))
  }
}

export function createCheckpointHandler(stores: CheckpointStores, scope: HistoryScope) {
  const trustedScope = { ...(decode(ScopeInput, scope) as typeof ScopeInput.Type) }

  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== "POST") throw new CheckpointRpcError("invalid")
      const url = new URL(request.url)
      if (url.origin !== origin || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "")
        throw new CheckpointRpcError("invalid")
      if (url.href !== `${origin}${url.pathname}`) throw new CheckpointRpcError("invalid")
      if (url.pathname === "/v1/upload") return await upload(stores, trustedScope, request)
      if (!["/v1/bootstrap", "/v1/begin", "/v1/archive", "/v1/publish", "/v1/publish-files"].includes(url.pathname))
        throw new CheckpointRpcError("invalid")
      if (!isJson(request.headers.get("content-type"))) throw new CheckpointRpcError("invalid")
      const input = await readJson(
        request,
        stores.bodyTimeoutMs ?? bodyTimeoutMs,
        url.pathname === "/v1/publish" ? maxCheckpointBodyBytes : maxBodyBytes,
      )

      if (url.pathname === "/v1/bootstrap") {
        exact(input, [])
        decode(BootstrapInput, input)
        return await bootstrap(stores, trustedScope)
      }
      if (url.pathname === "/v1/begin") {
        exact(input, ["writerID"])
        rejectEnvelopeScopeFields(input)
        return await begin(stores, trustedScope, decode(BeginInput, input) as typeof BeginInput.Type, request.signal)
      }
      if (url.pathname === "/v1/archive") {
        exact(
          input,
          input && typeof input === "object" && Object.hasOwn(input, "filesRevisionID")
            ? ["checkpointID", "kind", "filesRevisionID"]
            : ["checkpointID", "kind"],
        )
        rejectEnvelopeScopeFields(input)
        return await archive(stores, trustedScope, decode(ArchiveInput, input) as typeof ArchiveInput.Type)
      }
      if (url.pathname === "/v1/publish") {
        exact(input, ["epoch", "writerID", "checkpoint"])
        rejectEnvelopeScopeFields(input)
        const body = decode(PublishInput, input) as typeof PublishInput.Type
        const checkpoint = decodeCheckpoint(body.checkpoint)
        if (!stores.publisher?.publish) throw new CheckpointRpcError("unavailable")
        request.signal.throwIfAborted()
        const lease: HistoryLease = { ...trustedScope, epoch: body.epoch, writerID: body.writerID }
        const result = await stores.publisher.publish(lease, checkpoint)
        request.signal.throwIfAborted()
        return success({ data: result.data, digest: result.digest })
      }
      if (url.pathname === "/v1/publish-files") {
        exact(input, ["epoch", "writerID", "revision"])
        rejectEnvelopeScopeFields(input)
        const body = decode(PublishFilesInput, input) as typeof PublishFilesInput.Type
        const revision = decodeFileRevision(body.revision)
        if (!stores.publisher?.publishFiles) throw new CheckpointRpcError("unavailable")
        request.signal.throwIfAborted()
        const lease: HistoryLease = { ...trustedScope, epoch: body.epoch, writerID: body.writerID }
        const result = await stores.publisher.publishFiles(lease, revision)
        request.signal.throwIfAborted()
        return success({ data: result.data, digest: result.digest })
      }
      throw new CheckpointRpcError("invalid")
    } catch (error) {
      if (request.body && !request.body.locked) cancelStream(request.body)
      return failure(mapError(error))
    }
  }
}

async function begin(
  stores: CheckpointStores,
  scope: HistoryScope,
  input: typeof BeginInput.Type,
  signal: AbortSignal,
) {
  const masters = readMasterKeys(stores.masterKeyJson)
  try {
    if (!stores.backups?.save || !stores.publisher?.publish) throw new CheckpointRpcError("unavailable")
    const keyID = defaultBackupKeyID(masters)
    signal.throwIfAborted()
    if (await stores.history.checkpoint(scope)) throw new CheckpointRpcError("conflict")
    if ((await stores.history.epoch(scope)) !== 0) throw new CheckpointRpcError("conflict")
    signal.throwIfAborted()
    const lease = await stores.history.claim(scope, { expectedEpoch: 0, writerID: input.writerID })
    signal.throwIfAborted()
    if (lease.epoch !== 1 || lease.writerID !== input.writerID) throw new CheckpointRpcError("conflict")
    return success({
      lease: { epoch: lease.epoch, writerID: lease.writerID },
      keyID,
      key: derivedKey(scope, keyID, masters),
    })
  } finally {
    Object.values(masters).forEach((master) => master.fill(0))
  }
}

async function upload(stores: CheckpointStores, scope: HistoryScope, request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/octet-stream")
    throw new CheckpointRpcError("invalid")
  const announced = request.headers.get("content-length")
  if (!announced || !/^[1-9][0-9]*$/.test(announced)) throw new CheckpointRpcError("invalid")
  const length = Number(announced)
  if (!Number.isSafeInteger(length) || length > maxUploadBytes || !request.body) throw new CheckpointRpcError("invalid")
  const keyID = decode(BackupKeyID, request.headers.get("x-mongolgpt-backup-key-id")) as string
  if (!stores.backups?.save) throw new CheckpointRpcError("unavailable")
  const timeoutMs = stores.uploadTimeoutMs ?? uploadTimeoutMs
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > uploadTimeoutMs)
    throw new CheckpointRpcError("unavailable")
  const masters = readMasterKeys(stores.masterKeyJson)
  try {
    if (!Object.hasOwn(masters, keyID)) throw new CheckpointRpcError("invalid")
    request.signal.throwIfAborted()
    const reader = request.body.getReader()
    const deadline = Date.now() + timeoutMs
    let size = 0
    let complete = false
    let stopped = false
    let error: CheckpointRpcError | undefined
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const fail = (cause: CheckpointRpcError) => {
      if (error) return
      error = cause
      stopped = true
      controller.error(cause)
      cancelReader(reader)
    }
    // The store awaits cancellation in its finalizer. This wrapper never awaits
    // the caller's cancel hook, and errors even while storage applies backpressure.
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value
        },
        async pull(value) {
          try {
            const item = await readWithDeadline(reader, request.signal, deadline)
            if (stopped) return
            if (item.done) {
              if (size !== length) throw new CheckpointRpcError("invalid")
              complete = true
              stopped = true
              value.close()
              return
            }
            if (!(item.value instanceof Uint8Array) || size + item.value.byteLength > length)
              throw new CheckpointRpcError("invalid")
            size += item.value.byteLength
            value.enqueue(item.value)
          } catch (cause) {
            if (!stopped) fail(cause instanceof CheckpointRpcError ? cause : new CheckpointRpcError("invalid"))
          }
        },
        cancel() {
          stopped = true
          cancelReader(reader)
        },
      },
      { highWaterMark: 0 },
    )
    const abort = () => fail(new CheckpointRpcError("unavailable"))
    const timeout = setTimeout(abort, timeoutMs)
    request.signal.addEventListener("abort", abort, { once: true })
    try {
      const saved = await stores.backups.save(scope, { keyID, body })
      if (error) throw error
      if (!complete || saved.keyID !== keyID || saved.bytes !== length || Date.now() >= deadline)
        throw new CheckpointRpcError("unavailable")
      const receipt = { backupID: saved.backupID, keyID: saved.keyID, bytes: saved.bytes, sha256: saved.sha256 }
      decodeSecret(UploadReceipt, receipt)
      return success(receipt)
    } catch (cause) {
      // save() sanitizes stream failures; retain the boundary's exact error code.
      throw error ?? cause
    } finally {
      stopped = true
      clearTimeout(timeout)
      request.signal.removeEventListener("abort", abort)
      cancelReader(reader)
      releaseReader(reader)
    }
  } finally {
    Object.values(masters).forEach((master) => master.fill(0))
  }
}

async function bootstrap(stores: CheckpointStores, scope: HistoryScope) {
  const checkpoint = await acceptedCheckpoint(stores.history, scope)
  if (!checkpoint) return success({ checkpoint: null })
  const files = await stores.history.fileRevision(scope)
  if (files && files.data.checkpointID !== checkpoint.data.id) throw new CheckpointRpcError("conflict")
  const masters = readMasterKeys(stores.masterKeyJson)
  const sqlite = files?.data.sqlite ?? checkpoint.data.sqlite
  try {
    return success({
      checkpoint: checkpoint.data,
      ...(files ? { filesRevision: files.data } : {}),
      keys: {
        sqlite: derivedKey(scope, sqlite.keyID, masters),
        files: derivedKey(scope, (files?.data.archive ?? checkpoint.data.files).keyID, masters),
      },
    })
  } finally {
    Object.values(masters).forEach((master) => master.fill(0))
  }
}

async function archive(stores: CheckpointStores, scope: HistoryScope, input: typeof ArchiveInput.Type) {
  if (!stores.backups) throw new CheckpointRpcError("unavailable")
  const checkpoint = await stores.history.checkpoint(scope)
  if (!checkpoint) throw new CheckpointRpcError("conflict")
  if (checkpoint.data.id !== input.checkpointID) throw new CheckpointRpcError("conflict")
  const files = await stores.history.fileRevision(scope)
  if (files?.data.id !== input.filesRevisionID || (files && files.data.checkpointID !== input.checkpointID))
    throw new CheckpointRpcError("conflict")
  const accepted =
    input.kind === "files" && files
      ? files.data.archive
      : input.kind === "sqlite" && files?.data.sqlite
        ? files.data.sqlite
        : checkpoint.data[input.kind]
  const opened = await stores.backups.open(scope, accepted.backupID)
  if (!sameArchive(opened.manifest, accepted)) {
    cancelStream(opened.body)
    throw new CheckpointRpcError("conflict")
  }
  return new Response(opened.body, {
    status: 200,
    headers: { ...streamHeaders, "content-length": String(opened.manifest.bytes) },
  })
}

async function acceptedCheckpoint(history: HistoryStore, scope: HistoryScope): Promise<CheckpointRecord | undefined> {
  const checkpoint = await history.checkpoint(scope)
  if (checkpoint) return checkpoint
  if ((await history.epoch(scope)) === 0) return undefined
  throw new CheckpointRpcError("conflict")
}

function sameArchive(manifest: ArchiveManifest, accepted: CloudCheckpoint.Archive) {
  return (
    manifest.version === 1 &&
    manifest.format === "mongolgpt-sqlite-backup-v1" &&
    manifest.backupID === accepted.backupID &&
    manifest.keyID === accepted.keyID &&
    manifest.bytes === accepted.bytes &&
    manifest.sha256 === accepted.sha256
  )
}

function derivedKey(scope: HistoryScope, keyID: string, masters: Readonly<Record<string, Uint8Array>>) {
  const master = masters[keyID]
  if (!(master instanceof Uint8Array)) throw new CheckpointRpcError("unavailable")
  const key = deriveRuntimeBackupKey(scope, keyID, master)
  try {
    return Buffer.from(key).toString("base64")
  } finally {
    key.fill(0)
  }
}

function readMasterKeys(input: string | undefined) {
  const masters: Record<string, Uint8Array> = Object.create(null)
  const parsed = new Array<Uint8Array>()
  try {
    if (typeof input !== "string" || encoder.encode(input).byteLength > maxSecretBytes)
      throw new CheckpointRpcError("unavailable")
    const value = decodeSecret(Schema.UnknownFromJsonString, input)
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new CheckpointRpcError("unavailable")
    for (const [keyID, encoded] of Object.entries(value)) {
      decodeSecret(Identifier, keyID)
      if (typeof encoded !== "string") throw new CheckpointRpcError("unavailable")
      const master = Buffer.from(encoded, "base64")
      parsed.push(master)
      if (master.byteLength !== 32 || master.toString("base64") !== encoded) throw new CheckpointRpcError("unavailable")
      masters[keyID] = master
    }
    return masters
  } catch (error) {
    parsed.forEach((master) => master.fill(0))
    if (error instanceof CheckpointRpcError) throw error
    throw new CheckpointRpcError("unavailable")
  }
}

function defaultBackupKeyID(masters: Readonly<Record<string, Uint8Array>>) {
  const keyID = Object.keys(masters)
    .filter((item) => isBackupKeyID(item))
    .sort()[0]
  if (!keyID) throw new CheckpointRpcError("unavailable")
  return keyID
}

function isBackupKeyID(value: unknown) {
  try {
    decode(BackupKeyID, value)
    return true
  } catch {
    return false
  }
}

function isJson(contentType: string | null) {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json"
}

async function readJson(request: Request, timeoutMs: number, maxBytes = maxBodyBytes) {
  if (!request.body) throw new CheckpointRpcError("invalid")
  const reader = request.body.getReader()
  const chunks = new Array<Uint8Array>()
  let size = 0
  try {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const chunk = await readWithDeadline(reader, request.signal, deadline)
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array)) throw new CheckpointRpcError("invalid")
      size += chunk.value.byteLength
      if (size > maxBytes) {
        cancelReader(reader)
        throw new CheckpointRpcError("invalid")
      }
      chunks.push(chunk.value)
    }
    return decode(Schema.UnknownFromJsonString, decoder.decode(concat(chunks, size)))
  } catch (error) {
    cancelReader(reader)
    if (error instanceof TypeError) throw new CheckpointRpcError("invalid")
    throw error
  } finally {
    releaseReader(reader)
  }
}

function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  deadline: number,
): Promise<StreamReadResult> {
  if (signal.aborted) throw new CheckpointRpcError("unavailable")
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new CheckpointRpcError("unavailable")
  return new Promise<StreamReadResult>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const abort = () => finish(() => reject(new CheckpointRpcError("unavailable")))
    const timeout = setTimeout(() => finish(() => reject(new CheckpointRpcError("unavailable"))), remaining)
    signal.addEventListener("abort", abort, { once: true })
    reader.read().then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new CheckpointRpcError("invalid"))),
    )
  })
}

function concat(chunks: Uint8Array[], size: number) {
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function decode(schema: Parameters<typeof Schema.decodeUnknownSync>[0], value: unknown): unknown {
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" })
  } catch {
    throw new CheckpointRpcError("invalid")
  }
}

function decodeSecret(schema: Parameters<typeof Schema.decodeUnknownSync>[0], value: unknown): unknown {
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" })
  } catch {
    throw new CheckpointRpcError("unavailable")
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  void reader.cancel().catch(() => {})
}

function cancelStream(stream: ReadableStream<Uint8Array>) {
  void stream.cancel().catch(() => {})
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    reader.releaseLock()
  } catch {}
}

function exact(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CheckpointRpcError("invalid")
  const allowed = new Set(keys)
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !allowed.has(key)))
    throw new CheckpointRpcError("invalid")
}

function rejectEnvelopeScopeFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  if (["scope", "accountID", "workspaceID"].some((key) => Object.hasOwn(value, key))) {
    throw new CheckpointRpcError("invalid")
  }
}

function success(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders })
}

function failure(code: keyof typeof safeMessages) {
  return new Response(JSON.stringify({ error: { code, message: safeMessages[code] } }), {
    status: statuses[code],
    headers: jsonHeaders,
  })
}

function mapError(error: unknown): keyof typeof safeMessages {
  if (error instanceof CheckpointRpcError) return error.code
  if (error instanceof HistoryError) {
    if (error.code === "conflict" || error.code === "fenced") return "conflict"
    if (error.code === "invalid_input") return "invalid"
    return "unavailable"
  }
  if (error instanceof RuntimeBackupError) return "unavailable"
  return "unavailable"
}
