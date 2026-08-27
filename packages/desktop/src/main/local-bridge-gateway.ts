import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { connect } from "node:net"
import type { Duplex } from "node:stream"
import {
  createLocalBridgeAuthorizationCode,
  verifyLocalBridgeChallenge,
  type LocalBridgePairingRequest,
} from "@mongolgpt/local-bridge"
import type { ServerReadyData } from "../preload/types"

const CODE_TTL_MS = 2 * 60 * 1000
const SESSION_TTL_MS = 15 * 60 * 1000
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_CONCURRENT_PROXY_REQUESTS = 8
const MAX_PENDING = 16
const MAX_SESSIONS = 8
const BRIDGE_USERNAME = "bridge"
const SESSION_PATH = "/bridge/v1/session"
const PTY_CONNECT_PATH = /^\/pty\/[^/]+\/connect$/
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
const REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "if-match",
  "if-none-match",
  "last-event-id",
  "x-mongolgpt-directory",
  "x-mongolgpt-workspace",
])
const PROXY_HEADER_BLOCKLIST = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
])
const RESPONSE_HEADER_BLOCKLIST = new Set([
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "connection",
  "content-length",
  "keep-alive",
  "location",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
])
const WEBSOCKET_FORWARD_HEADERS = new Set([
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
])

type PendingPairing = LocalBridgePairingRequest & {
  code: string
  expiresAt: number
}

type BridgeSession = {
  accountID: string
  origin: string
  expiresAt: number
}

type LocalBridgeGatewayOptions = {
  sidecar: () => Promise<ServerReadyData>
  fetch?: typeof fetch
  now?: () => number
  randomBytes?: (length: number) => Uint8Array
  codeTtlMs?: number
  sessionTtlMs?: number
}

export type LocalBridgeAuthorization = {
  port: number
  code: string
  expiresAt: number
}

export function createLocalBridgeGateway(options: LocalBridgeGatewayOptions) {
  const requestFetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const randomBytes = options.randomBytes
  const codeTtlMs = options.codeTtlMs ?? CODE_TTL_MS
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS
  const pending = new Map<string, PendingPairing>()
  const sessions = new Map<string, BridgeSession>()
  const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const sockets = new Set<Duplex>()
  let listener: Server | undefined
  let port: number | undefined
  let starting: Promise<number> | undefined
  let generation = 0
  let stopped = false
  let activeProxyRequests = 0

  const closeConnections = () => {
    for (const socket of sockets) socket.destroy()
  }

  const expireSession = (digest: string) => {
    const session = sessions.get(digest)
    sessions.delete(digest)
    const timer = sessionTimers.get(digest)
    sessionTimers.delete(digest)
    if (timer) clearTimeout(timer)
    if (session) closeConnections()
  }

  const prune = () => {
    const time = now()
    for (const [code, item] of pending) if (item.expiresAt <= time) pending.delete(code)
    for (const [digest, session] of sessions) if (session.expiresAt <= time) expireSession(digest)
  }

  const originActive = (origin: string) => {
    prune()
    return (
      [...pending.values()].some((item) => item.origin === origin) ||
      [...sessions.values()].some((item) => item.origin === origin)
    )
  }

  const ensureStarted = () => {
    if (stopped) return Promise.reject(new Error("Дотоод холболтын gateway зогссон байна"))
    if (port !== undefined) return Promise.resolve(port)
    if (starting) return starting
    starting = new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => {
        void handleRequest(request, response).catch((error) => {
          const origin = request.headers.origin
          const allowedOrigin = origin && originActive(origin) ? origin : undefined
          if (error instanceof RequestBodyTooLarge) {
            respondJSON(response, 413, { error: "request_too_large" }, allowedOrigin)
            return
          }
          respondJSON(response, 502, { error: "bridge_unavailable" }, allowedOrigin)
        })
      })
      server.maxHeadersCount = 64
      server.headersTimeout = 10_000
      server.requestTimeout = 120_000
      server.on("connection", (socket) => {
        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))
      })
      server.on("upgrade", (request, socket, head) => {
        void handleUpgrade(request, socket, head)
      })
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") {
          server.close()
          reject(new Error("Bridge port авах боломжгүй байна"))
          return
        }
        listener = server
        port = address.port
        resolve(address.port)
      })
    }).finally(() => {
      starting = undefined
    })
    return starting
  }

  const authorize = async (request: LocalBridgePairingRequest): Promise<LocalBridgeAuthorization> => {
    prune()
    const authorizedGeneration = generation
    const bridgePort = await ensureStarted()
    if (stopped || authorizedGeneration !== generation) throw new Error("Дотоод холболтын хүсэлт хүчингүй болсон")
    const code = createLocalBridgeAuthorizationCode(randomBytes)
    const expiresAt = now() + codeTtlMs
    pending.set(code, { ...request, code, expiresAt })
    trimOldest(pending, MAX_PENDING, (item) => item.expiresAt)
    return { port: bridgePort, code, expiresAt }
  }

  const revokeAll = () => {
    generation++
    pending.clear()
    sessions.clear()
    for (const timer of sessionTimers.values()) clearTimeout(timer)
    sessionTimers.clear()
    closeConnections()
  }

  const stop = async () => {
    stopped = true
    revokeAll()
    const pendingStart = starting
    if (pendingStart) await pendingStart.catch(() => undefined)
    const server = listener
    listener = undefined
    port = undefined
    if (!server) return
    closeConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    if (!validHost(request.headers.host, port)) return respondJSON(response, 421, { error: "invalid_host" })
    const url = requestURL(request)
    if (!url) return respondJSON(response, 400, { error: "invalid_request" })
    const origin = request.headers.origin
    if (!origin || !originActive(origin)) return respondJSON(response, 403, { error: "invalid_origin" })

    if (request.method === "OPTIONS") return handlePreflight(request, response, origin)
    if (!request.method || !ALLOWED_METHODS.has(request.method)) {
      return respondJSON(response, 405, { error: "method_not_allowed" }, origin, {
        allow: [...ALLOWED_METHODS].join(", "),
      })
    }
    if (url.pathname === SESSION_PATH) return exchangeSession(request, response, origin)
    if (url.pathname.startsWith("/bridge/")) return respondJSON(response, 404, { error: "not_found" }, origin)

    const session = await authenticateSession(request.headers.authorization, origin)
    if (!session) return respondJSON(response, 401, { error: "invalid_session" }, origin)
    return proxyRequest(request, response, url, origin)
  }

  const exchangeSession = async (request: IncomingMessage, response: ServerResponse, origin: string) => {
    if (request.method !== "POST")
      return respondJSON(response, 405, { error: "method_not_allowed" }, origin, { allow: "POST" })
    if (!jsonContentType(request.headers["content-type"])) {
      return respondJSON(response, 415, { error: "invalid_content_type" }, origin)
    }

    const body = await readJSON(request, 8 * 1024).catch(() => undefined)
    if (
      !object(body) ||
      Object.keys(body).length !== 2 ||
      typeof body.code !== "string" ||
      typeof body.verifier !== "string"
    ) {
      return respondJSON(response, 400, { error: "invalid_exchange" }, origin)
    }

    prune()
    const pairing = pending.get(body.code)
    if (!pairing || pairing.origin !== origin) return respondJSON(response, 401, { error: "invalid_exchange" }, origin)
    pending.delete(body.code)
    if (!(await verifyLocalBridgeChallenge(body.verifier, pairing.challenge))) {
      return respondJSON(response, 401, { error: "invalid_exchange" }, origin)
    }

    const token = createLocalBridgeAuthorizationCode(randomBytes)
    const expiresAt = now() + sessionTtlMs
    const digest = tokenDigest(token)
    sessions.set(digest, { accountID: pairing.accountID, origin, expiresAt })
    const timer = setTimeout(() => expireSession(digest), Math.max(0, expiresAt - now()))
    timer.unref()
    sessionTimers.set(digest, timer)
    trimOldest(sessions, MAX_SESSIONS, (item) => item.expiresAt, expireSession)
    return respondJSON(
      response,
      200,
      { authenticated: true, username: BRIDGE_USERNAME, token, expiresAt, accountID: pairing.accountID },
      origin,
    )
  }

  const authenticateSession = async (
    authorization: string | undefined,
    origin: string,
  ): Promise<BridgeSession | undefined> => {
    const credentials = basicCredentials(authorization)
    if (!credentials || credentials.username !== BRIDGE_USERNAME) return undefined
    prune()
    const session = sessions.get(tokenDigest(credentials.password))
    if (!session || session.origin !== origin || session.expiresAt <= now()) return undefined
    return session
  }

  const handlePreflight = (request: IncomingMessage, response: ServerResponse, origin: string) => {
    const method = request.headers["access-control-request-method"]?.toUpperCase()
    if (!method || !ALLOWED_METHODS.has(method)) {
      return respondJSON(response, 403, { error: "invalid_preflight" }, origin)
    }
    const requested = (request.headers["access-control-request-headers"] ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
    if (requested.some((header) => !REQUEST_HEADERS.has(header))) {
      return respondJSON(response, 403, { error: "invalid_preflight" }, origin)
    }
    const headers: Record<string, string> = {
      "access-control-allow-headers": [...REQUEST_HEADERS].join(", "),
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-max-age": "300",
    }
    if (request.headers["access-control-request-private-network"] === "true") {
      headers["access-control-allow-private-network"] = "true"
    }
    response.writeHead(204, corsHeaders(origin, headers))
    response.end()
  }

  const proxyRequest = async (request: IncomingMessage, response: ServerResponse, url: URL, origin: string) => {
    if (activeProxyRequests >= MAX_CONCURRENT_PROXY_REQUESTS) {
      return respondJSON(response, 429, { error: "too_many_requests" }, origin, { "retry-after": "1" })
    }
    activeProxyRequests++
    try {
      return await proxyAuthenticatedRequest(request, response, url, origin)
    } finally {
      activeProxyRequests--
    }
  }

  const proxyAuthenticatedRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    origin: string,
  ) => {
    const sidecar = await options.sidecar()
    if (!sidecar.username || !sidecar.password) {
      return respondJSON(response, 503, { error: "sidecar_unavailable" }, origin)
    }
    const target = localSidecarURL(sidecar.url)
    const method = request.method ?? "GET"
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request, MAX_BODY_BYTES)
    const headers = proxyRequestHeaders(request, sidecar.username, sidecar.password)
    const controller = new AbortController()
    request.once("aborted", () => controller.abort())
    response.once("close", () => {
      if (!response.writableEnded) controller.abort()
    })
    const upstream = await requestFetch(new URL(`${url.pathname}${url.search}`, target), {
      method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    })
    const outgoing: Record<string, string> = corsHeaders(origin)
    upstream.headers.forEach((value, name) => {
      if (!RESPONSE_HEADER_BLOCKLIST.has(name.toLowerCase())) outgoing[name] = value
    })
    response.writeHead(upstream.status, upstream.statusText, outgoing)
    if (!upstream.body || method === "HEAD") return response.end()
    const reader = upstream.body.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!response.write(chunk.value)) await new Promise<void>((resolve) => response.once("drain", resolve))
      }
      response.end()
    } finally {
      reader.releaseLock()
    }
  }

  const handleUpgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number, message: string) => rejectUpgrade(socket, status, message)
    if (!validHost(request.headers.host, port)) return reject(421, "Misdirected Request")
    const url = requestURL(request)
    if (
      !url ||
      !PTY_CONNECT_PATH.test(url.pathname) ||
      !url.searchParams.get("ticket") ||
      url.searchParams.has("auth_token")
    ) {
      return reject(401, "Unauthorized")
    }
    const origin = request.headers.origin
    if (!origin || !originActive(origin) || ![...sessions.values()].some((session) => session.origin === origin)) {
      return reject(403, "Forbidden")
    }

    let sidecar: ServerReadyData
    try {
      sidecar = await options.sidecar()
    } catch {
      return reject(503, "Service Unavailable")
    }
    let target: URL
    try {
      target = localSidecarURL(sidecar.url)
    } catch {
      return reject(503, "Service Unavailable")
    }
    // The sidecar mints and atomically consumes the scoped one-time PTY ticket.
    const upstream = connect({ host: target.hostname, port: Number(target.port) })
    upstream.once("error", () => socket.destroy())
    upstream.once("close", () => socket.destroy())
    socket.once("error", () => upstream.destroy())
    socket.once("close", () => upstream.destroy())
    upstream.once("connect", () => {
      upstream.write(upgradeRequest(request, url, target))
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
  }

  return { authorize, revokeAll, stop }
}

function proxyRequestHeaders(request: IncomingMessage, username: string, password: string) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (PROXY_HEADER_BLOCKLIST.has(name.toLowerCase()) || value === undefined) continue
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
    else headers.set(name, value)
  }
  headers.set("authorization", `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`)
  return headers
}

function upgradeRequest(request: IncomingMessage, url: URL, target: URL) {
  const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`]
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || !WEBSOCKET_FORWARD_HEADERS.has(name)) continue
    if (Array.isArray(value)) value.forEach((item) => lines.push(`${name}: ${item}`))
    else lines.push(`${name}: ${value}`)
  }
  lines.push(`host: ${target.host}`)
  lines.push("origin: mongolgpt-renderer://renderer")
  lines.push("connection: Upgrade")
  lines.push("upgrade: websocket")
  return `${lines.join("\r\n")}\r\n\r\n`
}

function basicCredentials(value: string | undefined): { username: string; password: string } | undefined {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(value ?? "")
  if (!match) return undefined
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8")
    if (Buffer.from(decoded).toString("base64") !== match[1]) return undefined
    const separator = decoded.indexOf(":")
    if (separator < 1) return undefined
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
  } catch {
    return undefined
  }
}

function requestURL(request: IncomingMessage): URL | undefined {
  try {
    const value = request.url ?? "/"
    if (/^https?:\/\//i.test(value)) return undefined
    return new URL(value, "http://127.0.0.1")
  } catch {
    return undefined
  }
}

function validHost(value: string | undefined, port: number | undefined) {
  if (!value || port === undefined) return false
  try {
    const url = new URL(`http://${value}`)
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && Number(url.port) === port
  } catch {
    return false
  }
}

function jsonContentType(value: string | undefined) {
  return value?.toLowerCase().split(";", 1)[0]?.trim() === "application/json"
}

async function readJSON(request: IncomingMessage, limit: number) {
  return JSON.parse((await readBody(request, limit)).toString("utf8")) as unknown
}

async function readBody(request: IncomingMessage, limit: number) {
  const declared = request.headers["content-length"]
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new RequestBodyTooLarge()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > limit) throw new RequestBodyTooLarge()
    chunks.push(value)
  }
  return Buffer.concat(chunks, size)
}

class RequestBodyTooLarge extends Error {}

function localSidecarURL(value: string) {
  const url = new URL(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (
    url.protocol !== "http:" ||
    (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid_sidecar")
  }
  return url
}

function tokenDigest(token: string) {
  return createHash("sha256").update(token).digest("base64url")
}

function corsHeaders(origin: string, input: Record<string, string> = {}) {
  return {
    ...input,
    "access-control-allow-origin": origin,
    "cache-control": "no-store",
    vary: "Origin",
    "x-content-type-options": "nosniff",
  }
}

function respondJSON(
  response: ServerResponse,
  status: number,
  value: unknown,
  origin?: string,
  input: Record<string, string> = {},
) {
  if (response.headersSent || response.destroyed) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    ...input,
    ...(origin ? corsHeaders(origin) : { "cache-control": "no-store", "x-content-type-options": "nosniff" }),
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
  })
  response.end(body)
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
  if (socket.destroyed) return
  const response = `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`
  socket.write(response, () => socket.end())
}

function trimOldest<Key, Value>(
  map: Map<Key, Value>,
  limit: number,
  expiresAt: (value: Value) => number,
  remove: (key: Key) => void = (key) => void map.delete(key),
) {
  while (map.size > limit) {
    const oldest = [...map.entries()].sort((left, right) => expiresAt(left[1]) - expiresAt(right[1]))[0]
    if (!oldest) return
    remove(oldest[0])
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
