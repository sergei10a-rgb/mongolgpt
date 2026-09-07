import { Buffer } from "node:buffer"
import { Schema } from "effect"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { createRuntimeBackupStore, deriveRuntimeBackupKey, RuntimeBackupError } from "./backup"
import { createHistoryStore, HistoryError, type HistoryScope } from "./history"

const origin = "http://checkpoint.mongolgpt.internal"
const maxBodyBytes = 4096
const maxSecretBytes = 32 * 1024
const bodyTimeoutMs = 5000
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
  invalid: "Cloud checkpoint хүсэлт буруу байна.",
  conflict: "Cloud checkpoint-ийн төлөв зөрсөн байна. Сессийг дахин ачаална уу.",
  unavailable: "Cloud checkpoint үйлчилгээнд холбогдож чадсангүй.",
} as const
const statuses = {
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
const ArchiveInput = Schema.Struct({
  checkpointID: UUID,
  kind: Schema.Union([Schema.Literal("sqlite"), Schema.Literal("files")]),
})

type CheckpointRecord = { data: CloudCheckpoint.Checkpoint; digest?: string }
type HistoryStore = Pick<ReturnType<typeof createHistoryStore>, "checkpoint" | "epoch">
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
}
type CheckpointStores = {
  history: HistoryStore
  backups?: BackupStore
  masterKeyJson?: string
  bodyTimeoutMs?: number
}

class CheckpointRpcError extends Error {
  constructor(readonly code: keyof typeof safeMessages) {
    super(safeMessages[code])
    this.name = "CheckpointRpcError"
  }
}

export async function handleCheckpointOutbound(
  request: Request,
  env: { HISTORY?: D1Database; RUNTIME_BACKUPS?: R2Bucket; MONGOLGPT_RUNTIME_BACKUP_KEYS?: string },
  context: { params?: unknown },
): Promise<Response> {
  if (!env.HISTORY) return failure("unavailable")
  try {
    return createCheckpointHandler(
      {
        history: createHistoryStore(env.HISTORY),
        backups: env.RUNTIME_BACKUPS ? createRuntimeBackupStore(env.RUNTIME_BACKUPS) : undefined,
        masterKeyJson: env.MONGOLGPT_RUNTIME_BACKUP_KEYS,
      },
      decode(ScopeInput, context.params) as typeof ScopeInput.Type,
    )(request)
  } catch {
    return failure("unavailable")
  }
}

export function createCheckpointHandler(stores: CheckpointStores, scope: HistoryScope) {
  const trustedScope = { ...(decode(ScopeInput, scope) as typeof ScopeInput.Type) }

  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== "POST") throw new CheckpointRpcError("invalid")
      if (!isJson(request.headers.get("content-type"))) throw new CheckpointRpcError("invalid")
      const url = new URL(request.url)
      if (url.origin !== origin || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "")
        throw new CheckpointRpcError("invalid")
      const input = await readJson(request, stores.bodyTimeoutMs ?? bodyTimeoutMs)

      if (url.pathname === "/v1/bootstrap") {
        exact(input, [])
        decode(BootstrapInput, input)
        return await bootstrap(stores, trustedScope)
      }
      if (url.pathname === "/v1/archive") {
        exact(input, ["checkpointID", "kind"])
        rejectEnvelopeScopeFields(input)
        return await archive(stores, trustedScope, decode(ArchiveInput, input) as typeof ArchiveInput.Type)
      }
      throw new CheckpointRpcError("invalid")
    } catch (error) {
      return failure(mapError(error))
    }
  }
}

async function bootstrap(stores: CheckpointStores, scope: HistoryScope) {
  const checkpoint = await acceptedCheckpoint(stores.history, scope)
  if (!checkpoint) return success({ checkpoint: null })
  const masters = readMasterKeys(stores.masterKeyJson)
  try {
    return success({
      checkpoint: checkpoint.data,
      keys: {
        sqlite: derivedKey(scope, checkpoint.data.sqlite.keyID, masters),
        files: derivedKey(scope, checkpoint.data.files.keyID, masters),
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
  const accepted = checkpoint.data[input.kind]
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

function isJson(contentType: string | null) {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json"
}

async function readJson(request: Request, timeoutMs: number) {
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
      if (size > maxBodyBytes) {
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
