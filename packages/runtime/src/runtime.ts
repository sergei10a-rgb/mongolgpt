import { issueRuntimeCapability, runtimeGatewayHeader, verifyRuntimeCapability } from "@mongolgpt/runtime-auth"
import { checkpointControlEnv, deriveCheckpointControlToken } from "@mongolgpt/runtime-auth/control"

const PORT = 4096
export const RUNTIME_PROCESS_ID = "mongolgpt-server"
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
  MONGOLGPT_CLOUD_HISTORY?: string
  STAGE: string
}

export interface RuntimeRateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

type RuntimeDependencies<Environment extends RuntimeVariables> = {
  sandbox(
    env: Environment,
    id: string,
    scope: { readonly accountID: string; readonly workspaceID: string },
  ): RuntimeSandbox | Promise<RuntimeSandbox>
  report?(failure: RuntimeFailure): void
  schedule?: (callback: () => void, delay: number) => () => void
}

const runtimeFailureMessages = {
  runtime_process_lookup_failed: "Cloud runtime процессийн төлөвийг шалгаж чадсангүй.",
  runtime_process_start_failed: "Cloud runtime процессийг эхлүүлж чадсангүй.",
  runtime_process_exited: "Cloud runtime процесс сервер бэлэн болохоос өмнө зогслоо.",
  runtime_process_status_failed: "Cloud runtime процессийн ажиллагааны төлөвийг уншиж чадсангүй.",
  runtime_process_port_timeout: "Cloud runtime сервер хугацаандаа бэлэн болсонгүй.",
  runtime_proxy_failed: "Cloud runtime хүсэлтийг контейнер рүү дамжуулж чадсангүй.",
  runtime_websocket_proxy_failed: "Cloud runtime-ийн шууд холболтыг контейнер рүү дамжуулж чадсангүй.",
  runtime_unavailable: "Cloud coding runtime-г эхлүүлж чадсангүй. Түр хүлээгээд дахин оролдоно уу.",
} as const

type RuntimeFailureCode = keyof typeof runtimeFailureMessages

const sdkCodes = new Set([
  "CONTAINER_UNAVAILABLE",
  "INTERNAL_ERROR",
  "OPERATION_INTERRUPTED",
  "PORT_ALREADY_EXPOSED",
  "PORT_IN_USE",
  "PORT_NOT_EXPOSED",
  "PORT_OPERATION_ERROR",
  "PROCESS_ERROR",
  "PROCESS_NOT_FOUND",
  "PROCESS_PERMISSION_DENIED",
  "PROCESS_READY_TIMEOUT",
  "PROCESS_EXITED_BEFORE_READY",
  "RPC_TRANSPORT_ERROR",
  "SERVICE_NOT_RESPONDING",
  "UNKNOWN_ERROR",
])

const sdkKinds = new Set([
  "peer_closed",
  "connection_failed",
  "upgrade_failed",
  "invalid_frame",
  "protocol_error",
  "session_disposed",
  "unknown",
])

const sdkReasons = new Set([
  "runtime_replaced",
  "transport_disposed",
  "sandbox_lifetime_changed",
  "recovery_exhausted",
  "rpc_upgrade_failed",
])

const containerReasons = new Set([
  "container_starting",
  "container_unhealthy",
  "container_replaced",
  "rpc_upgrade_failed",
  "no_container_instance_available",
  "max_container_instances_exceeded",
  "container_unreachable",
])

export function createRuntimeProcessStarter<Process extends { readonly status: string }>(
  lookup: () => Promise<Process | null>,
) {
  let pending: Promise<Process> | undefined
  return (start: () => Promise<Process>) => {
    if (pending) return pending
    const operation = (async () => {
      const existing = await lookup()
      if (existing && (existing.status === "starting" || existing.status === "running")) return existing
      return start()
    })()
    pending = operation
    operation.then(
      () => {
        if (pending === operation) pending = undefined
      },
      () => {
        if (pending === operation) pending = undefined
      },
    )
    return operation
  }
}

export type RuntimeDiagnostic = {
  readonly code: string
  readonly kind?: string
  readonly reason?: string
  readonly exitCode?: number
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function readExitCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined
}

export function sanitizeRuntimeDiagnostic(error: unknown): RuntimeDiagnostic | undefined {
  try {
    const response = readProperty(error, "errorResponse")
    const code = readString(readProperty(error, "code")) ?? readString(readProperty(response, "code"))
    if (!code || !sdkCodes.has(code)) return undefined

    const context = readRecord(readProperty(error, "context") ?? readProperty(response, "context"))
    const diagnostic: RuntimeDiagnostic = { code }
    const kind = readString(context && readProperty(context, "kind"))
    const reason = readString(context && readProperty(context, "reason"))
    const exitCode = readExitCode(context && readProperty(context, "exitCode"))
    if (code === "RPC_TRANSPORT_ERROR" && kind && sdkKinds.has(kind)) return { ...diagnostic, kind }
    if (code === "OPERATION_INTERRUPTED" && reason && sdkReasons.has(reason)) {
      return { ...diagnostic, reason }
    }
    if (code === "CONTAINER_UNAVAILABLE" && reason && containerReasons.has(reason)) {
      return { ...diagnostic, reason }
    }
    if (code === "PROCESS_EXITED_BEFORE_READY" && exitCode !== undefined) {
      return { ...diagnostic, exitCode }
    }
    return diagnostic
  } catch {
    return undefined
  }
}

function diagnosticSuffix(diagnostic: RuntimeDiagnostic | undefined) {
  if (!diagnostic) return ""
  const detail = diagnostic.kind ?? diagnostic.reason
  const exitCode = diagnostic.exitCode === undefined ? "" : `, гаралтын код: ${diagnostic.exitCode}`
  return ` Лавлах код: ${diagnostic.code}${detail ? `/${detail}` : ""}${exitCode}`
}

export class RuntimeFailure extends Error {
  private constructor(
    readonly code: RuntimeFailureCode,
    readonly diagnostic?: RuntimeDiagnostic,
  ) {
    super(runtimeFailureMessages[code])
    this.name = "RuntimeFailure"
  }

  static create(code: RuntimeFailureCode, error?: unknown) {
    return new RuntimeFailure(code, sanitizeRuntimeDiagnostic(error))
  }

  messageFor(stage: string) {
    return stage.trim() === "dev" ? `${this.message}${diagnosticSuffix(this.diagnostic)}` : this.message
  }
}

type Authentication = {
  account: {
    id: string
  }
  workspace: {
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

    const directory = requestDirectory(request, url)
    if (!directory) {
      return cors(json({ error: "Cloud workspace-ийн зам зөвшөөрөгдсөн хүрээнээс гарсан байна." }, 400), appOrigin)
    }

    try {
      const body = await boundedRequestBody(request)
      const identity = await deriveRuntimeIdentity(
        authentication.account.id,
        authentication.workspace.id,
        env.MONGOLGPT_RUNTIME_SECRET,
      )
      const sandbox = await dependencies.sandbox(env, identity.sandboxID, {
        accountID: authentication.account.id,
        workspaceID: authentication.workspace.id,
      })
      const restore = env.MONGOLGPT_CLOUD_HISTORY === "true"
      const checkpointToken = restore
        ? await deriveCheckpointControlToken(env.MONGOLGPT_RUNTIME_SECRET, {
            accountID: authentication.account.id,
            workspaceID: authentication.workspace.id,
          })
        : undefined
      await ensureServer(sandbox, identity.password, consoleOrigin, restore, checkpointToken)
      if (authentication.expiresAt <= Date.now()) {
        return cors(json({ error: "Runtime сессийн хугацаа дууссан байна. Дахин нэвтэрнэ үү." }, 401), appOrigin)
      }
      const gatewayToken = await issueRuntimeCapability({
        accountID: authentication.account.id,
        workspaceID: authentication.workspace.id,
        authVersion: authentication.authVersion,
        audience: consoleOrigin,
        secret: env.MONGOLGPT_RUNTIME_AUTH_SECRET,
        ttlSeconds: 90,
      })
      const internal = internalRequest(
        request,
        identity.password,
        directory,
        body,
        gatewayToken,
        authentication.workspace.id,
      )

      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const response = await sandbox.wsConnect(internal, PORT).catch((error) => {
          throw RuntimeFailure.create("runtime_websocket_proxy_failed", error)
        })
        return expireWebSocket(response, authentication.expiresAt, dependencies.schedule ?? scheduleTimeout)
      }
      const response = await sandbox.containerFetch(internal, PORT).catch((error) => {
        throw RuntimeFailure.create("runtime_proxy_failed", error)
      })
      return cors(response, appOrigin)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return cors(json({ error: "Хүсэлтийн хэмжээ 16 MiB хязгаараас хэтэрсэн байна." }, 413), appOrigin)
      }
      const failure = error instanceof RuntimeFailure ? error : RuntimeFailure.create("runtime_unavailable", error)
      dependencies.report?.(failure)
      const body = {
        error: failure.code,
        code: failure.code,
        message: failure.messageFor(env.STAGE),
        ...(env.STAGE.trim() === "dev" && failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
      }
      return cors(json(body, 502), appOrigin)
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
          workspace: authentication.workspace,
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
        workspace: authentication.workspace,
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
      workspace: { id: capability.workspaceID },
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

export async function deriveRuntimeIdentity(accountID: string, workspaceID: string, secret: string) {
  const account = accountID.trim()
  const workspace = workspaceID.trim()
  const runtimeSecret = secret.trim()
  if (!account) throw new Error("Аккаунтын ID шаардлагатай")
  if (!workspace.startsWith("wrk_") || workspace.length < 5 || workspace.length > 30) {
    throw new Error("Ажлын талбарын ID буруу байна")
  }
  if (runtimeSecret.length < 32) throw new Error("Ажиллах орчны нууц утга хамгийн багадаа 32 тэмдэгттэй байх ёстой")

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(runtimeSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const [sandboxBytes, passwordBytes] = await Promise.all([
    crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`sandbox:${account}:${workspace}`)),
    crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`password:${account}:${workspace}`)),
  ])

  return {
    sandboxID: `workspace-${hex(new Uint8Array(sandboxBytes)).slice(0, 40)}`,
    password: base64Url(new Uint8Array(passwordBytes)),
  }
}

export function hostedDirectory(raw: string | null) {
  if (!raw) return WORKSPACE_ROOT

  const decoded = decodeDirectory(raw)
  if (!decoded) return null
  // Legacy handlers decode once more; reject residual escapes instead of allowing a second path interpretation.
  if (/%[0-9a-f]{2}/i.test(decoded)) return null
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

function requestDirectory(request: Request, url: URL) {
  const selectors = ["directory", "location[directory]"].map((name) => url.searchParams.getAll(name))
  if (selectors.some((values) => values.length > 1)) return null
  const header = request.headers.get("x-mongolgpt-directory")
  const values = [...(header === null ? [] : [header]), ...selectors.flat()].map(hostedDirectory)
  if (values.length === 0) return WORKSPACE_ROOT
  const directory = values[0]
  return directory && values.every((value) => value === directory) ? directory : null
}

async function ensureServer(
  sandbox: RuntimeSandbox,
  password: string,
  consoleOrigin: string,
  restore: boolean,
  checkpointToken?: string,
) {
  const existing = await sandbox.getProcess(RUNTIME_PROCESS_ID).catch((error) => {
    throw RuntimeFailure.create("runtime_process_lookup_failed", error)
  })
  if (existing && (await waitForServer(existing, sandbox, password))) {
    if (restore && !(await serverResponding(sandbox, password, true)))
      throw RuntimeFailure.create("runtime_unavailable")
    return
  }

  const started = await sandbox
    .startProcess("/usr/local/bin/mongolgpt serve --hostname 0.0.0.0 --port 4096", {
      processId: RUNTIME_PROCESS_ID,
      autoCleanup: true,
      cwd: WORKSPACE_ROOT,
      env: {
        HOME: WORKSPACE_ROOT,
        XDG_DATA_HOME: `${WORKSPACE_ROOT}/.mongolgpt/data`,
        XDG_CONFIG_HOME: `${WORKSPACE_ROOT}/.mongolgpt/config`,
        XDG_CACHE_HOME: `${WORKSPACE_ROOT}/.mongolgpt/cache`,
        // SDK persistent sessions may predate CA setup; make Bun trust explicit for the hosted server process.
        NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
        MONGOLGPT_SERVER_USERNAME: SERVER_USERNAME,
        MONGOLGPT_SERVER_PASSWORD: password,
        MONGOLGPT_DISABLE_SHARE: "true",
        MONGOLGPT_AUTO_SHARE: "false",
        MONGOLGPT_RUNTIME_MODE: "hosted",
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_CONSOLE_URL: consoleOrigin,
        MONGOLGPT_API_KEY: "runtime",
        ...(restore
          ? {
              MONGOLGPT_CLOUD_HISTORY: "true",
              MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE: "true",
              MONGOLGPT_RUNTIME_SUPERVISOR: "true",
              [checkpointControlEnv]: checkpointToken!,
              MONGOLGPT_DB: `${WORKSPACE_ROOT}/.mongolgpt/runtime.sqlite`,
              XDG_STATE_HOME: `${WORKSPACE_ROOT}/.mongolgpt/state`,
            }
          : {}),
      },
    })
    .catch(async (error) => {
      const concurrent = await sandbox.getProcess(RUNTIME_PROCESS_ID).catch(() => undefined)
      if (!concurrent) throw RuntimeFailure.create("runtime_process_start_failed", error)
      return concurrent
    })

  if (!(await waitForServer(started, sandbox, password))) throw RuntimeFailure.create("runtime_process_exited")
  if (restore && !(await serverResponding(sandbox, password, true))) throw RuntimeFailure.create("runtime_unavailable")
}

async function waitForServer(process: RuntimeProcess, sandbox: RuntimeSandbox, password: string) {
  const status = await process.getStatus().catch((error) => {
    throw RuntimeFailure.create("runtime_process_status_failed", error)
  })
  if (status !== "starting" && status !== "running") return false
  await process
    .waitForPort(PORT, {
      mode: "tcp",
      timeout: START_TIMEOUT_MS,
      interval: 500,
    })
    .catch(async (error) => {
      // A failed control-plane stream does not prove the application server is down.
      if (await serverResponding(sandbox, password)) return
      throw RuntimeFailure.create("runtime_process_port_timeout", error)
    })
  return true
}

async function serverResponding(sandbox: RuntimeSandbox, password: string, restored = false) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(false)
    }, 5_000)
  })
  const probe = async () => {
    const response = await sandbox.containerFetch(
      new Request("http://localhost/global/health", {
        headers: { authorization: `Basic ${btoa(`${SERVER_USERNAME}:${password}`)}` },
        redirect: "manual",
        signal: controller.signal,
      }),
      PORT,
    )
    if (
      controller.signal.aborted ||
      response.status !== 200 ||
      (restored && response.headers.get("x-mongolgpt-runtime-history") !== "checkpoint-v1") ||
      (restored && response.headers.get("x-mongolgpt-runtime-isolation") !== "cgroup-v1") ||
      (restored && response.headers.get("x-mongolgpt-runtime-publication") !== "tool-pty-v1") ||
      response.headers.get("content-type")?.split(";")[0].trim() !== "application/json"
    ) {
      void response.body?.cancel().catch(() => {})
      return false
    }
    const reader = response.body?.getReader()
    if (!reader) return false
    const cancel = () => {
      void reader.cancel().catch(() => {})
    }
    controller.signal.addEventListener("abort", cancel, { once: true })
    const decoder = new TextDecoder()
    let size = 0
    let body = ""
    try {
      while (true) {
        const chunk = await reader.read()
        if (controller.signal.aborted) return false
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 1_024) return false
        body += decoder.decode(chunk.value, { stream: true })
      }
      const health = readRecord(JSON.parse(body + decoder.decode()))
      return health?.healthy === true && typeof health.version === "string" && health.version.trim().length > 0
    } finally {
      controller.signal.removeEventListener("abort", cancel)
      cancel()
      reader.releaseLock()
    }
  }
  try {
    return await Promise.race([probe(), deadline])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

function internalRequest(
  request: Request,
  password: string,
  directory: string,
  body: Uint8Array | undefined,
  gatewayToken: string,
  workspaceID: string,
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
    "x-org-id",
    runtimeGatewayHeader,
  ]) {
    headers.delete(name)
  }
  headers.set("authorization", `Basic ${btoa(`${SERVER_USERNAME}:${password}`)}`)
  headers.set("x-mongolgpt-directory", encodeURIComponent(directory))
  headers.set("x-org-id", workspaceID)
  headers.set(runtimeGatewayHeader, gatewayToken)
  // SDK GET/HEAD requests use query selectors, which take precedence over headers downstream.
  const url = new URL(request.url)
  for (const name of ["directory", "location[directory]"]) {
    if (url.searchParams.has(name)) url.searchParams.set(name, directory)
  }
  const requestBody = body ? Uint8Array.from(body) : undefined
  return new Request(url, {
    method: request.method,
    headers,
    body: requestBody,
    signal: request.signal,
    redirect: request.redirect,
  })
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
      void reader.cancel().catch(() => {})
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
