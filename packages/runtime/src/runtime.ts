import { issueRuntimeCapability, runtimeGatewayHeader, verifyRuntimeCapability } from "@mongolgpt/runtime-auth"

const PORT = 4096
const PROCESS_ID = "mongolgpt-server"
const SERVER_USERNAME = "mongolgpt"
const WORKSPACE_ROOT = "/workspace"
const START_TIMEOUT_MS = 120_000
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024
const RATE_LIMIT_PERIOD_SECONDS = 60
const RUNTIME_COOKIE_NAME = "__Host-mongolgpt-runtime"

type ProcessStatus = "starting" | "running" | "completed" | "failed" | "killed" | "error"

export interface RuntimeProcess {
  readonly status: ProcessStatus
  getStatus(): Promise<ProcessStatus>
  waitForPort(
    port: number,
    options: {
      mode: "tcp"
      timeout: number
      interval: number
    },
  ): Promise<void>
}

export interface RuntimeSandbox {
  getProcess(id: string): Promise<RuntimeProcess | null>
  startProcess(
    command: string,
    options: {
      processId: string
      autoCleanup: boolean
      cwd: string
      env: Record<string, string>
    },
  ): Promise<RuntimeProcess>
  containerFetch(request: Request, port: number): Promise<Response>
  wsConnect(request: Request, port: number): Promise<Response>
}

export interface RuntimeVariables {
  MONGOLGPT_APP_ORIGIN: string
  MONGOLGPT_CONSOLE_URL: string
  MONGOLGPT_RUNTIME_AUTH_SECRET: string
  MONGOLGPT_RUNTIME_BURST_LIMITER: RuntimeRateLimiter
  MONGOLGPT_RUNTIME_RATE_LIMITER: RuntimeRateLimiter
  MONGOLGPT_RUNTIME_SECRET: string
  MONGOLGPT_RUNTIME_VERSION?: string
  STAGE: string
}

export interface RuntimeRateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

type RuntimeDependencies<Environment extends RuntimeVariables> = {
  sandbox(env: Environment, id: string): RuntimeSandbox
  report?(error: unknown): void
  schedule?: (callback: () => void, delay: number) => () => void
}

type Authentication = {
  account: {
    id: string
  }
  authVersion: number
  expiresAt: number
}

type TokenSource = {
  value?: string
  invalid?: true
}

export function createRuntimeHandler<Environment extends RuntimeVariables>(
  dependencies: RuntimeDependencies<Environment>,
) {
  return async (request: Request, env: Environment) => {
    const appOrigin = configuredOrigin(env.MONGOLGPT_APP_ORIGIN)
    const consoleOrigin = configuredOrigin(env.MONGOLGPT_CONSOLE_URL)
    const configured = Boolean(
      appOrigin &&
        consoleOrigin &&
        env.STAGE?.trim() &&
        env.MONGOLGPT_RUNTIME_VERSION?.trim() &&
        env.MONGOLGPT_RUNTIME_AUTH_SECRET?.trim().length >= 32 &&
        env.MONGOLGPT_RUNTIME_SECRET?.trim().length >= 32 &&
        env.MONGOLGPT_RUNTIME_BURST_LIMITER &&
        env.MONGOLGPT_RUNTIME_RATE_LIMITER,
    )
    const url = new URL(request.url)

    if (url.pathname === "/global/health") {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"])
      const response = json(
        configured
          ? {
              healthy: true,
              service: "mongolgpt-runtime",
              stage: env.STAGE.trim(),
              version: env.MONGOLGPT_RUNTIME_VERSION!.trim(),
            }
          : {
              healthy: false,
              service: "mongolgpt-runtime",
              error: "Runtime тохиргоо бүрэн биш байна.",
            },
        configured ? 200 : 503,
      )
      return request.headers.get("origin") === appOrigin && appOrigin ? cors(response, appOrigin) : response
    }

    if (!configured || !appOrigin || !consoleOrigin) {
      return json({ error: "Runtime үйлчилгээний тохиргоо бүрэн биш байна." }, 503)
    }

    if (request.method === "OPTIONS") {
      if (request.headers.get("origin") !== appOrigin) return json({ error: "Хориотой origin байна." }, 403)
      return cors(new Response(null, { status: 204 }), appOrigin, true)
    }

    if (request.headers.get("origin") !== appOrigin) {
      return json({ error: "MongolGPT веб апп-аас хүсэлт илгээнэ үү." }, 403)
    }

    if (url.pathname === "/auth/session") return session(request, env.MONGOLGPT_RUNTIME_AUTH_SECRET, appOrigin)

    const authentication = await requestAuthentication(
      request,
      env.MONGOLGPT_RUNTIME_AUTH_SECRET,
      request.headers.get("upgrade")?.toLowerCase() === "websocket",
    )
    if (!authentication) return cors(json({ error: "Нэвтэрч орно уу." }, 401), appOrigin)

    const limited = await enforceRateLimit(env, authentication.account.id)
    if (limited === "unavailable") {
      return cors(json({ error: "Runtime хамгаалалтын үйлчилгээнд түр холбогдож чадсангүй." }, 503), appOrigin)
    }
    if (limited === "exceeded") {
      return cors(
        json({ error: "Runtime хүсэлтийн хязгаар түр хэтэрлээ. Нэг минутын дараа дахин оролдоно уу." }, 429, {
          "retry-after": String(RATE_LIMIT_PERIOD_SECONDS),
        }),
        appOrigin,
      )
    }

    const directory = hostedDirectory(request.headers.get("x-mongolgpt-directory"))
    if (!directory) {
      return cors(json({ error: "Cloud workspace-ийн зам зөвшөөрөгдсөн хүрээнээс гарсан байна." }, 400), appOrigin)
    }

    try {
      const body = await boundedRequestBody(request)
      const identity = await deriveRuntimeIdentity(authentication.account.id, env.MONGOLGPT_RUNTIME_SECRET)
      const sandbox = dependencies.sandbox(env, identity.sandboxID)
      await ensureServer(sandbox, identity.password, consoleOrigin)
      if (authentication.expiresAt <= Date.now()) {
        return cors(json({ error: "Runtime сессийн хугацаа дууссан байна. Дахин нэвтэрнэ үү." }, 401), appOrigin)
      }
      const gatewayToken = await issueRuntimeCapability({
        accountID: authentication.account.id,
        authVersion: authentication.authVersion,
        audience: consoleOrigin,
        secret: env.MONGOLGPT_RUNTIME_AUTH_SECRET,
        ttlSeconds: 90,
      })
      const internal = internalRequest(request, identity.password, directory, body, gatewayToken)

      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const response = await sandbox.wsConnect(internal, PORT)
        return expireWebSocket(response, authentication.expiresAt, dependencies.schedule ?? scheduleTimeout)
      }
      return cors(await sandbox.containerFetch(internal, PORT), appOrigin)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return cors(json({ error: "Хүсэлтийн хэмжээ 16 MiB хязгаараас хэтэрсэн байна." }, 413), appOrigin)
      }
      dependencies.report?.(error)
      return cors(
        json({ error: "Cloud coding runtime-г эхлүүлж чадсангүй. Түр хүлээгээд дахин оролдоно уу." }, 502),
        appOrigin,
      )
    }
  }
}

function expireWebSocket(
  response: Response,
  expiresAt: number,
  schedule: NonNullable<RuntimeDependencies<never>["schedule"]>,
) {
  const socket = response.webSocket
  if (!socket) return response

  const cancel = schedule(
    () => socket.close(4001, "MongolGPT runtime сесс дууссан"),
    Math.max(0, expiresAt - Date.now()),
  )
  socket.addEventListener("close", cancel, { once: true })
  socket.addEventListener("error", cancel, { once: true })
  return response
}

function scheduleTimeout(callback: () => void, delay: number) {
  const timer = setTimeout(callback, delay)
  return () => clearTimeout(timer)
}

async function session(request: Request, secret: string, appOrigin: string) {
  if (request.method === "POST") {
    const capability = bearerToken(request.headers.get("authorization"))
    if (capability.invalid || !capability.value) return cors(json({ authenticated: false }, 401), appOrigin)

    const authentication = await authenticate(capability.value, request, secret)
    if (!authentication) return cors(json({ authenticated: false }, 401), appOrigin)

    const maxAge = Math.floor(authentication.expiresAt / 1000 - Date.now() / 1000)
    if (maxAge < 1) return cors(json({ authenticated: false }, 401), appOrigin)
    return cors(
      json(
        {
          authenticated: true,
          account: authentication.account,
          expiresAt: authentication.expiresAt,
        },
        200,
        { "set-cookie": runtimeCookie(capability.value, maxAge) },
      ),
      appOrigin,
    )
  }

  if (request.method === "DELETE") {
    return cors(json({ authenticated: false }, 200, { "set-cookie": clearRuntimeCookie() }), appOrigin)
  }

  if (request.method !== "GET") return cors(methodNotAllowed(["GET", "POST", "DELETE"]), appOrigin)
  const authentication = await requestAuthentication(request, secret, false)
  if (!authentication) return cors(json({ authenticated: false }, 401), appOrigin)
  return cors(
    json(
      {
        authenticated: true,
        account: authentication.account,
        expiresAt: authentication.expiresAt,
      },
      200,
    ),
    appOrigin,
  )
}

async function requestAuthentication(request: Request, secret: string, websocket: boolean) {
  const bearer = bearerToken(request.headers.get("authorization"))
  const cookie = runtimeCookieToken(request.headers.get("cookie"))
  if (bearer.invalid || cookie.invalid || (websocket && bearer.value) || (!websocket && bearer.value && cookie.value)) {
    return null
  }

  const token = websocket ? cookie.value : (bearer.value ?? cookie.value)
  return token ? authenticate(token, request, secret) : null
}

async function authenticate(token: string, request: Request, secret: string): Promise<Authentication | null> {
  try {
    const capability = await verifyRuntimeCapability({
      token,
      audience: new URL(request.url).origin,
      secret,
    })
    return {
      account: { id: capability.sub },
      authVersion: capability.authVersion,
      expiresAt: capability.exp * 1000,
    }
  } catch {
    return null
  }
}

function bearerToken(value: string | null): TokenSource {
  if (value === null) return {}
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(value)
  return match ? { value: match[1] } : { invalid: true }
}

function runtimeCookieToken(value: string | null): TokenSource {
  if (!value) return {}
  const tokens = value
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${RUNTIME_COOKIE_NAME}=`))
    .map((item) => item.slice(RUNTIME_COOKIE_NAME.length + 1))
  if (tokens.length === 0) return {}
  if (tokens.length !== 1 || !tokens[0]) return { invalid: true }
  return { value: tokens[0] }
}

function runtimeCookie(token: string, maxAge: number) {
  return `${RUNTIME_COOKIE_NAME}=${token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Strict`
}

function clearRuntimeCookie() {
  return `${RUNTIME_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`
}

async function enforceRateLimit(env: RuntimeVariables, accountID: string) {
  try {
    const key = `account:${accountID}`
    const [burst, sustained] = await Promise.all([
      env.MONGOLGPT_RUNTIME_BURST_LIMITER.limit({ key }),
      env.MONGOLGPT_RUNTIME_RATE_LIMITER.limit({ key }),
    ])
    return burst.success && sustained.success ? "allowed" : "exceeded"
  } catch {
    return "unavailable"
  }
}

export async function deriveRuntimeIdentity(accountID: string, secret: string) {
  const account = accountID.trim()
  const runtimeSecret = secret.trim()
  if (!account) throw new Error("Аккаунтын ID шаардлагатай")
  if (runtimeSecret.length < 32) throw new Error("Ажиллах орчны нууц утга хамгийн багадаа 32 тэмдэгттэй байх ёстой")

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(runtimeSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const [sandboxBytes, passwordBytes] = await Promise.all([
    crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`sandbox:${account}`)),
    crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`password:${account}`)),
  ])

  return {
    sandboxID: `account-${hex(new Uint8Array(sandboxBytes)).slice(0, 40)}`,
    password: base64Url(new Uint8Array(passwordBytes)),
  }
}

export function hostedDirectory(raw: string | null) {
  if (!raw) return WORKSPACE_ROOT

  const decoded = decodeDirectory(raw)
  if (!decoded) return null
  if (decoded === "/" || decoded === ".") return WORKSPACE_ROOT

  const relative = decoded.startsWith(`${WORKSPACE_ROOT}/`)
    ? decoded.slice(WORKSPACE_ROOT.length + 1)
    : decoded === WORKSPACE_ROOT
      ? ""
      : decoded.startsWith("/")
        ? null
        : decoded
  if (relative === null) return null

  const segments = relative.split("/").filter((segment) => segment && segment !== ".")
  if (segments.some((segment) => segment === ".." || segment.includes("\\") || /[\u0000-\u001f]/.test(segment))) {
    return null
  }
  return segments.length ? `${WORKSPACE_ROOT}/${segments.join("/")}` : WORKSPACE_ROOT
}

async function ensureServer(sandbox: RuntimeSandbox, password: string, consoleOrigin: string) {
  const existing = await sandbox.getProcess(PROCESS_ID)
  if (existing && (await waitForServer(existing))) return

  const started = await sandbox
    .startProcess("/usr/local/bin/mongolgpt serve --hostname 0.0.0.0 --port 4096", {
      processId: PROCESS_ID,
      autoCleanup: true,
      cwd: WORKSPACE_ROOT,
      env: {
        HOME: WORKSPACE_ROOT,
        XDG_DATA_HOME: `${WORKSPACE_ROOT}/.mongolgpt/data`,
        XDG_CONFIG_HOME: `${WORKSPACE_ROOT}/.mongolgpt/config`,
        XDG_CACHE_HOME: `${WORKSPACE_ROOT}/.mongolgpt/cache`,
        MONGOLGPT_SERVER_USERNAME: SERVER_USERNAME,
        MONGOLGPT_SERVER_PASSWORD: password,
        MONGOLGPT_DISABLE_SHARE: "true",
        MONGOLGPT_AUTO_SHARE: "false",
        MONGOLGPT_RUNTIME_MODE: "hosted",
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_CONSOLE_URL: consoleOrigin,
        MONGOLGPT_API_KEY: "runtime",
      },
    })
    .catch(async (error) => {
      const concurrent = await sandbox.getProcess(PROCESS_ID)
      if (!concurrent) throw error
      return concurrent
    })

  if (!(await waitForServer(started))) throw new Error("MongolGPT сервер бэлэн болохоосоо өмнө зогслоо")
}

async function waitForServer(process: RuntimeProcess) {
  const status = await process.getStatus()
  if (status !== "starting" && status !== "running") return false
  await process.waitForPort(PORT, {
    mode: "tcp",
    timeout: START_TIMEOUT_MS,
    interval: 500,
  })
  return true
}

function internalRequest(
  request: Request,
  password: string,
  directory: string,
  body: Uint8Array | undefined,
  gatewayToken: string,
) {
  const headers = new Headers(request.headers)
  for (const name of [
    "cookie",
    "authorization",
    "origin",
    "referer",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    runtimeGatewayHeader,
  ]) {
    headers.delete(name)
  }
  headers.set("authorization", `Basic ${btoa(`${SERVER_USERNAME}:${password}`)}`)
  headers.set("x-mongolgpt-directory", encodeURIComponent(directory))
  headers.set(runtimeGatewayHeader, gatewayToken)
  const requestBody = body ? Uint8Array.from(body) : undefined
  return new Request(request, requestBody ? { headers, body: requestBody } : { headers })
}

class RequestBodyTooLarge extends Error {}

async function boundedRequestBody(request: Request) {
  if (!request.body) return undefined

  const declared = request.headers.get("content-length")
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BODY_BYTES)) {
    throw new RequestBodyTooLarge()
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel()
      throw new RequestBodyTooLarge()
    }
    chunks.push(next.value)
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function configuredOrigin(value: string) {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null
    if (url.pathname !== "/" && url.pathname !== "") return null
    return url.origin
  } catch {
    return null
  }
}

function decodeDirectory(value: string) {
  try {
    return decodeURIComponent(value).replaceAll("//", "/").trim()
  } catch {
    return null
  }
}

function methodNotAllowed(methods: string[]) {
  return json({ error: "Энэ HTTP арга дэмжигдэхгүй байна." }, 405, { allow: methods.join(", ") })
}

function json(value: unknown, status = 200, input: HeadersInit = {}) {
  const headers = new Headers(input)
  headers.set("content-type", "application/json; charset=utf-8")
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store")
  headers.set("x-content-type-options", "nosniff")
  return new Response(JSON.stringify(value), { status, headers })
}

function cors(response: Response, origin: string, preflight = false) {
  const headers = new Headers(response.headers)
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store")
  headers.set("access-control-allow-origin", origin)
  headers.set("access-control-allow-credentials", "true")
  headers.set("vary", appendVary(headers.get("vary"), "Origin"))
  if (preflight) {
    headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
    headers.set(
      "access-control-allow-headers",
      "authorization, content-type, last-event-id, x-mongolgpt-directory, x-mongolgpt-workspace",
    )
    headers.set("access-control-max-age", "600")
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function appendVary(value: string | null, name: string) {
  if (!value) return name
  const parts = value.split(",").map((item) => item.trim().toLowerCase())
  return parts.includes(name.toLowerCase()) ? value : `${value}, ${name}`
}

function hex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function base64Url(value: Uint8Array) {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}
