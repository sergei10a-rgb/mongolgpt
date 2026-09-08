import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { createHash, timingSafeEqual, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"

type NativeFixture = typeof import("./history-native.ts")
type HistoryScope = { accountID: string; workspaceID: string }
type BridgeConfig = {
  root: string
  nativeBundle: string
  port: number
  scope: HistoryScope
  secret: string
  adminToken: string
  dropFirstClaimResponse?: boolean
}

const hostCheckpoint = "checkpoint.mongolgpt.internal"
const hostHistory = "history.mongolgpt.internal"
const bridgeKeyID = "synthetic_bridge_master"
const migrationNames = ["0001_history.sql", "0002_history_checkpoint.sql", "0003_file_revision.sql"] as const
const checkpointPaths = new Set([
  "/v1/bootstrap",
  "/v1/begin",
  "/v1/upload",
  "/v1/archive",
  "/v1/publish",
  "/v1/publish-files",
])
const historyPaths = new Set(["/v1/epoch", "/v1/claim", "/v1/append", "/v1/erase", "/v1/read"])
const adminPaths = new Set(["/__test/health", "/__test/status"])
const jsonHeaders = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" } as const
const migrationLedgerTable = "container_checkpoint_bridge_migration"
const counters = new Map<string, Map<number, number>>()
const activeRequests = new Set<AbortController>()
const injected = { droppedClaimResponses: 0, archiveResponsesWithoutLength: 0 }
const historyRequests: HistoryRequestRecord[] = []

type HistoryRequestRecord = {
  path: string
  status: number
  injected?: "dropped_first_claim_response"
  claim?: {
    expectedEpoch: number
    writerHash: string
    checkpointHash: string | null
    filesRevisionHash: string | null
    hasCheckpointID: boolean
    hasFilesRevisionID: boolean
  }
}

const configPath = process.argv[2]
if (!configPath)
  throw new Error("usage: node --experimental-strip-types container-checkpoint-bridge.ts CONFIG_JSON_PATH")

const config = decodeConfig(await readJsonFile(configPath))
await mkdir(config.root, { recursive: true, mode: 0o700 })
const backupMaster = await loadSyntheticBackupMaster(config.root)
const native: NativeFixture = await import(pathToFileURL(config.nativeBundle).href)
// Wrangler places transient files beside its config even with explicit persist.
// Keep those files inside the disposable bridge root, never in the source tree.
const platformConfig = join(config.root, "history-d1.jsonc")
await copyFile(fileURLToPath(new URL("./history-d1.jsonc", import.meta.url)), platformConfig)
const platform = await getPlatformProxy<{ DB: D1Database; BACKUPS: R2Bucket }>({
  configPath: platformConfig,
  persist: { path: join(config.root, "platform") },
  remoteBindings: false,
  envFiles: [],
})
await applyMigrations(platform.env.DB)

const scope = Object.freeze({ ...config.scope })
const store = native.createHistoryStore(
  platform.env.DB as unknown as Parameters<NativeFixture["createHistoryStore"]>[0],
)
const env = Object.freeze({
  HISTORY: platform.env.DB as unknown as NonNullable<
    Parameters<NativeFixture["handleCheckpointOutbound"]>[1]["HISTORY"]
  >,
  RUNTIME_BACKUPS: platform.env.BACKUPS as unknown as NonNullable<
    Parameters<NativeFixture["handleCheckpointOutbound"]>[1]["RUNTIME_BACKUPS"]
  >,
  MONGOLGPT_RUNTIME_BACKUP_KEYS: JSON.stringify({ [backupMaster.keyID]: backupMaster.master }),
  MONGOLGPT_RUNTIME_SECRET: config.secret,
})

const server = createServer((request, response) => {
  void handleNodeRequest(request, response).catch(() => {
    if (!response.destroyed) {
      writeJson(response, 500, { error: "bridge_unavailable" })
      incrementCounter(pathnameOf(request), 500)
    }
  })
})

let closing = false
server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
})

await new Promise<void>((resolve, reject) => {
  server.once("error", reject)
  server.listen(config.port, "127.0.0.1", () => {
    server.off("error", reject)
    resolve()
  })
})

const address = server.address()
if (!address || typeof address === "string") throw new Error("bridge did not bind to a TCP port")
process.stdout.write(`BRIDGE_READY ${JSON.stringify({ port: address.port })}\n`)

process.once("SIGTERM", () => void shutdown(0))
process.once("SIGINT", () => void shutdown(130))

async function handleNodeRequest(request: IncomingMessage, response: ServerResponse) {
  const controller = new AbortController()
  activeRequests.add(controller)
  let finished = false
  request.once("aborted", () => controller.abort())
  response.once("finish", () => {
    finished = true
  })
  response.once("close", () => {
    if (!finished) controller.abort()
  })
  try {
    let result = await dispatch(request, controller.signal)
    const omitArchiveLength =
      hostFromHeader(request.headers.host) === hostCheckpoint &&
      pathnameOf(request) === "/v1/archive" &&
      request.method === "POST" &&
      result.ok
    if (omitArchiveLength) {
      // Workerd strips this header from streamed archive responses.
      const headers = new Headers(result.headers)
      headers.delete("content-length")
      result = new Response(result.body, { status: result.status, statusText: result.statusText, headers })
    }
    incrementCounter(pathnameOf(request), result.status)
    await writeFetchResponse(response, result, controller)
    if (omitArchiveLength && response.writableFinished && !response.hasHeader("content-length")) {
      injected.archiveResponsesWithoutLength = Math.min(1000, injected.archiveResponsesWithoutLength + 1)
    }
  } finally {
    activeRequests.delete(controller)
  }
}

async function dispatch(request: IncomingMessage, signal: AbortSignal): Promise<Response> {
  if (closing) return json(503, { error: "bridge_closing" })
  const host = hostFromHeader(request.headers.host)
  const incoming = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`)

  if (adminPaths.has(incoming.pathname)) {
    if (!isLoopbackHost(host) || request.method !== "GET") return json(404, { error: "not_found" })
    if (!adminTokenMatches(request.headers["x-test-admin-token"])) return json(403, { error: "forbidden" })
    if (incoming.pathname === "/__test/health") return json(200, { ready: true })
    return json(200, await statusBody())
  }

  if (host === hostHistory) {
    if (!historyPaths.has(incoming.pathname)) return json(404, { error: "not_found" })
    return handleHistoryRequest(request, incoming.pathname, signal)
  }

  if (host === hostCheckpoint) {
    if (!checkpointPaths.has(incoming.pathname)) return json(404, { error: "not_found" })
    const forwarded = toFetchRequest(request, hostCheckpoint, signal)
    return native.handleCheckpointOutbound(forwarded, env, { params: scope })
  }

  return json(404, { error: "not_found" })
}

async function handleHistoryRequest(request: IncomingMessage, path: string, signal: AbortSignal) {
  const body = hasRequestBody(request) ? await readRequestBody(request, signal) : undefined
  const claim = path === "/v1/claim" ? claimRecord(body) : undefined
  const forwarded = toFetchRequest(request, hostHistory, signal, body)
  const result = await native.handleHistoryOutbound(forwarded, { HISTORY: env.HISTORY }, { params: scope })
  const record: HistoryRequestRecord = { path, status: result.status, ...(claim ? { claim } : {}) }
  if (
    config.dropFirstClaimResponse &&
    path === "/v1/claim" &&
    result.status === 200 &&
    injected.droppedClaimResponses === 0
  ) {
    injected.droppedClaimResponses++
    record.injected = "dropped_first_claim_response"
    historyRequests.push(record)
    void result.body?.cancel().catch(() => {})
    return json(503, {
      error: { code: "unavailable", message: "Cloud түүхийг хадгалах үйлчилгээнд холбогдож чадсангүй." },
    })
  }
  historyRequests.push(record)
  return result
}

async function statusBody() {
  const requestPathStatusCounters = Object.fromEntries(
    Array.from(counters.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, statuses]) => [
        path,
        Object.fromEntries(
          Array.from(statuses.entries())
            .sort(([left], [right]) => left - right)
            .map(([status, count]) => [String(status), count]),
        ),
      ]),
  )
  const statusCounters = new Map<number, number>()
  for (const statuses of counters.values()) {
    for (const [status, count] of statuses) statusCounters.set(status, (statusCounters.get(status) ?? 0) + count)
  }
  return {
    ready: true,
    epoch: await store.epoch(scope),
    checkpoint: (await store.checkpoint(scope)) ?? null,
    revision: (await store.fileRevision(scope)) ?? null,
    injected: { ...injected },
    historyRequests: historyRequests.slice(),
    requestPathStatusCounters,
    statusCounters: Object.fromEntries(
      Array.from(statusCounters.entries())
        .sort(([left], [right]) => left - right)
        .map(([status, count]) => [String(status), count]),
    ),
  }
}

function toFetchRequest(request: IncomingMessage, host: string, signal: AbortSignal, body?: Uint8Array) {
  const url = new URL(request.url ?? "/", `http://${host}`)
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: toFetchHeaders(request.headers),
    signal,
  }
  if (hasRequestBody(request)) {
    if (body) init.body = body.slice().buffer
    else {
      init.body = Readable.toWeb(request) as unknown as BodyInit
      init.duplex = "half"
    }
  }
  return new Request(`http://${host}${url.pathname}${url.search}`, init)
}

async function writeFetchResponse(response: ServerResponse, result: Response, controller: AbortController) {
  if (response.destroyed) {
    result.body?.cancel().catch(() => {})
    return
  }
  response.statusCode = result.status
  response.statusMessage = result.statusText
  result.headers.forEach((value, key) => response.setHeader(key, value))
  if (!result.body) {
    response.end()
    return
  }
  const close = () => result.body?.cancel().catch(() => {})
  response.once("close", close)
  try {
    const stream = Readable.fromWeb(result.body as unknown as Parameters<typeof Readable.fromWeb>[0])
    await pipeline(stream, response, { signal: controller.signal })
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    response.off("close", close)
    if (controller.signal.aborted) result.body?.cancel().catch(() => {})
  }
}

async function applyMigrations(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${migrationLedgerTable} (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
    )
    .run()
  for (const name of migrationNames) {
    if (await migrationApplied(db, name)) continue
    const migration = await readFile(fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)), "utf8")
    const statements = unstable_splitSqlQuery(migration).map((statement) => db.prepare(statement))
    statements.push(
      db.prepare(`INSERT INTO ${migrationLedgerTable} (name, applied_at) VALUES (?, ?)`).bind(name, Date.now()),
    )
    const results = await db.batch(statements)
    if (results.some((result) => !result.success)) throw new Error(`failed to apply bridge migration ${name}`)
  }
}

async function migrationApplied(db: D1Database, name: string) {
  const row = await db
    .prepare(`SELECT name FROM ${migrationLedgerTable} WHERE name = ?`)
    .bind(name)
    .first<{ name: string }>()
  return row?.name === name
}

async function loadSyntheticBackupMaster(root: string) {
  const file = privatePath(root, ".container-checkpoint-bridge-master.json")
  try {
    return decodeMaster(JSON.parse(await readFile(file, "utf8")))
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error
  }
  const generated = { keyID: bridgeKeyID, master: randomBytes(32).toString("base64") }
  const body = `${JSON.stringify(generated)}\n`
  try {
    await writeFile(file, body, { mode: constants.S_IRUSR | constants.S_IWUSR, flag: "wx" })
    return generated
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error
    return decodeMaster(JSON.parse(await readFile(file, "utf8")))
  }
}

function privatePath(root: string, name: string) {
  const rootPath = resolve(root)
  const file = resolve(rootPath, name)
  const inside = relative(rootPath, file)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error("bridge private file escaped configured root")
  }
  return file
}

function decodeConfig(value: unknown): BridgeConfig {
  if (!plainObject(value)) throw new Error("bridge config must be a JSON object")
  const config = value as Record<string, unknown>
  const root = stringField(config, "root")
  const nativeBundle = stringField(config, "nativeBundle")
  const secret = stringField(config, "secret")
  const adminToken = stringField(config, "adminToken")
  const dropFirstClaimResponse = config.dropFirstClaimResponse
  const port = config.port
  if (!isAbsolute(root)) throw new Error("bridge config root must be absolute")
  if (!isAbsolute(nativeBundle)) throw new Error("bridge config nativeBundle must be absolute")
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("bridge config port must be 0-65535")
  if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("bridge config secret must be >=32 bytes")
  if (adminToken.length !== 64 || !/^[0-9a-f]+$/i.test(adminToken))
    throw new Error("bridge config adminToken must be exactly 64 hex characters")
  const scope = scopeField(config.scope)
  if (dropFirstClaimResponse !== undefined && typeof dropFirstClaimResponse !== "boolean") {
    throw new Error("bridge config dropFirstClaimResponse must be a boolean")
  }
  return {
    root: resolve(root),
    nativeBundle: resolve(nativeBundle),
    port,
    scope,
    secret,
    adminToken,
    dropFirstClaimResponse,
  }
}

function scopeField(value: unknown): HistoryScope {
  if (!plainObject(value)) throw new Error("bridge config scope must be an object")
  const scope = value as Record<string, unknown>
  const accountID = stringField(scope, "accountID")
  const workspaceID = stringField(scope, "workspaceID")
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(accountID) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(workspaceID)) {
    throw new Error("bridge config scope identifiers are invalid")
  }
  return { accountID, workspaceID }
}

function decodeMaster(value: unknown) {
  if (!plainObject(value)) throw new Error("bridge synthetic backup master must be a JSON object")
  const keyID = stringField(value, "keyID")
  const master = stringField(value, "master")
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(keyID)) throw new Error("bridge backup key id is invalid")
  const bytes = Buffer.from(master, "base64")
  if (bytes.byteLength !== 32 || bytes.toString("base64") !== master) throw new Error("bridge backup master is invalid")
  return { keyID, master }
}

async function readJsonFile(path: string) {
  if (!isAbsolute(path)) throw new Error("bridge config path must be absolute")
  return JSON.parse(await readFile(path, "utf8"))
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key]
  if (typeof field !== "string" || field.length === 0) throw new Error(`bridge config ${key} must be a string`)
  return field
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  )
}

function hasRequestBody(request: IncomingMessage) {
  return request.method !== "GET" && request.method !== "HEAD"
}

async function readRequestBody(request: IncomingMessage, signal: AbortSignal) {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request) {
    signal.throwIfAborted()
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk)
    size += bytes.byteLength
    if (size > 1024 * 1024 + 4096) throw new Error("bridge request body too large")
    chunks.push(bytes.slice())
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function claimRecord(body: Uint8Array | undefined): HistoryRequestRecord["claim"] | undefined {
  if (!body) return undefined
  try {
    const value = JSON.parse(new TextDecoder().decode(body))
    if (!plainObject(value)) return undefined
    const expectedEpoch = value.expectedEpoch
    const writerID = value.writerID
    if (typeof expectedEpoch !== "number" || typeof writerID !== "string") return undefined
    const checkpointID = typeof value.checkpointID === "string" ? value.checkpointID : undefined
    const filesRevisionID = typeof value.filesRevisionID === "string" ? value.filesRevisionID : undefined
    return {
      expectedEpoch,
      writerHash: safeHash(writerID),
      checkpointHash: checkpointID ? safeHash(checkpointID) : null,
      filesRevisionHash: filesRevisionID ? safeHash(filesRevisionID) : null,
      hasCheckpointID: checkpointID !== undefined,
      hasFilesRevisionID: filesRevisionID !== undefined,
    }
  } catch {
    return undefined
  }
}

function safeHash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function toFetchHeaders(headers: IncomingHttpHeaders) {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item)
      continue
    }
    result.append(key, value)
  }
  return result
}

function hostFromHeader(value: string | undefined) {
  if (!value) return ""
  const normalized = value.toLowerCase()
  if (normalized.startsWith("[")) {
    const end = normalized.indexOf("]")
    return end === -1 ? normalized : normalized.slice(1, end)
  }
  return normalized.split(":")[0] ?? ""
}

function isLoopbackHost(host: string) {
  return host === "127.0.0.1" || host === "localhost"
}

function adminTokenMatches(value: string | string[] | undefined) {
  if (typeof value !== "string") return false
  const actual = Buffer.from(value)
  const expected = Buffer.from(config.adminToken)
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

function incrementCounter(path: string, status: number) {
  const byStatus = counters.get(path) ?? new Map<number, number>()
  byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
  counters.set(path, byStatus)
}

function pathnameOf(request: IncomingMessage) {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname
  } catch {
    return "<invalid>"
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders })
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, jsonHeaders)
  response.end(JSON.stringify(body))
}

async function shutdown(code: number) {
  if (closing) return
  closing = true
  for (const request of activeRequests) request.abort()
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeAllConnections?.()
  await closed
  await platform.dispose()
  process.exit(code)
}

function isNodeError(error: unknown, code: string) {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
}
