import { resolveHostedServiceUrls } from "@mongolgpt/account-contract/service-urls"
import { deploymentEndpoints } from "./deployment"
import type { DeploymentPreflightResult } from "./deployment"

export type AppRuntimeContract = {
  channel: "dev" | "beta" | "prod"
  mode: "local-bridge" | "hosted"
  serverUrl: string
}

export type HtmlAssetContract = {
  kind: "script" | "stylesheet" | "modulepreload"
  url: string
}

export type AnonymousHostedSessionContract = {
  authenticated: false
}

export type AnonymousRuntimeApiContract = {
  error: "Нэвтэрч орно уу."
}

export type PaymentHealthContract = {
  status: "disabled" | "ok"
  environment: "disabled" | "sandbox" | "production"
}

export type RuntimeHealthContract = {
  healthy: true
  service: "mongolgpt-runtime"
  stage: string
  version: string
}

export type AuthenticatedSmokeAccount = {
  accountID: string
  email: string
  workspaceID: string
}

export type AuthenticatedRuntimeToken = {
  token: string
  expiresAt: number
  accountID: string
}

export function inspectDeploymentEndpointConfiguration(
  endpoints: ReturnType<typeof deploymentEndpoints>,
  result: DeploymentPreflightResult,
) {
  const urls = resolveHostedServiceUrls(result.domain, result.stage)
  if (urls.stageDomain !== result.stageDomain) {
    throw new Error(`deployment stage domain is misconfigured for ${result.stage}`)
  }
  const expected: Record<string, string> = {
    docs: urls.docs,
    app: urls.app,
  }
  if (result.hostedServices) {
    Object.assign(expected, {
      console: urls.console,
      consoleHealth: `${urls.console}/api/health`,
      authHealth: `${urls.auth}/health`,
      runtimeHealth: `${urls.runtime}/global/health`,
      paymentHealth: `${urls.payment}/health`,
    })
  }
  if (result.adminEnabled) expected.admin = urls.admin

  for (const [name, url] of Object.entries(expected)) {
    if (endpoints[name as keyof typeof endpoints] !== url) {
      throw new Error(`deployment ${name} endpoint is misconfigured for ${result.stage}: expected ${url}`)
    }
  }
}

export function inspectHtmlContentType(contentType: string | null, label: string) {
  const mediaType = normalizedMediaType(contentType)
  if (mediaType !== "text/html") {
    throw new Error(`${label} is not HTML: ${contentType || "missing content-type"}`)
  }
}

export function inspectJsonApiPayload(contentType: string | null, payload: string, label: string): unknown {
  const mediaType = normalizedMediaType(contentType)
  if (mediaType !== "application/json") {
    throw new Error(`${label} is not JSON: ${contentType || "missing content-type"}`)
  }

  inspectNotHtmlShell(payload, label)

  try {
    return JSON.parse(payload)
  } catch {
    throw new Error(`${label} body is not valid JSON`)
  }
}

function attribute(tag: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return tag.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1]
}

function meta(html: string, name: string) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    if (attribute(tag, "name") === name) return attribute(tag, "content")
  }
  return undefined
}

function metaHttpEquiv(html: string, value: string) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    if (attribute(tag, "http-equiv")?.toLowerCase() === value.toLowerCase()) return attribute(tag, "content")
  }
  return undefined
}

function canonicalHref(html: string) {
  const tags = html.match(/<link\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    const rel = attribute(tag, "rel")
      ?.split(/\s+/)
      .map((value) => value.toLowerCase())
    if (rel?.includes("canonical")) return attribute(tag, "href")
  }
  return undefined
}

function normalizeHttpUrl(input: string, label: string) {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`)
  }
  return url.toString().replace(/\/+$/, "")
}

function isHtmlShell(payload: string) {
  return /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(payload)
}

function inspectNotHtmlShell(payload: string, label: string) {
  if (isHtmlShell(payload)) {
    throw new Error(`${label} returned an HTML/static shell instead of JSON`)
  }
}

function exactObjectKeys(value: Record<string, unknown>, expected: string[], label: string) {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unexpected shape`)
  }
}

function normalizedMediaType(contentType: string | null) {
  const values = contentType
    ?.split(",")
    .map((value) => value.split(";", 1)[0]?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value))
  if (!values?.length || values.some((value) => value !== values[0])) return undefined
  return values[0]
}

export function inspectResponseOrigin(input: {
  requestUrl: string
  responseUrl?: string | null
  status: number
  location?: string | null
  label: string
}) {
  const expected = new URL(normalizeHttpUrl(input.requestUrl, `${input.label} request URL`))
  if (input.status >= 300 && input.status < 400) {
    if (!input.location) {
      throw new Error(`${input.label} redirected without a Location header`)
    }
    const target = new URL(input.location, expected)
    if (target.origin !== expected.origin) {
      throw new Error(`${input.label} redirect leaves the expected origin: ${target.origin} != ${expected.origin}`)
    }
  }

  if (!input.responseUrl) return
  const actual = new URL(normalizeHttpUrl(input.responseUrl, `${input.label} response URL`))
  if (actual.origin !== expected.origin) {
    throw new Error(`${input.label} response left the expected origin: ${actual.origin} != ${expected.origin}`)
  }
}

export function inspectDocsRootRedirect(input: {
  docsUrl: string
  status: number
  contentType: string | null
  location?: string | null
  body: string
}) {
  const canonical = new URL(input.docsUrl)
  canonical.pathname = `${canonical.pathname.replace(/\/+$/, "")}/`
  canonical.search = ""
  canonical.hash = ""
  const root = new URL("/", canonical)

  if (input.status >= 300 && input.status < 400) {
    if (!input.location) throw new Error("docs root redirected without a Location header")
    const target = new URL(input.location, root)
    if (target.toString() !== canonical.toString()) {
      throw new Error(`docs root redirect target is invalid: ${target}`)
    }
    return canonical.toString()
  }

  if (input.status !== 200) throw new Error(`docs root returned HTTP ${input.status}; expected redirect or 200`)
  inspectHtmlContentType(input.contentType, "docs root response")
  const refresh = metaHttpEquiv(input.body, "refresh")?.match(/^\s*0\s*;\s*url=(.+?)\s*$/i)?.[1]
  const href = canonicalHref(input.body)
  if (!refresh || new URL(refresh, root).toString() !== canonical.toString()) {
    throw new Error("docs root HTML refresh target is invalid")
  }
  if (!href || new URL(href, root).toString() !== canonical.toString()) {
    throw new Error("docs root canonical link is invalid")
  }
  return canonical.toString()
}

export function inspectAdminProtection(input: {
  requestUrl: string
  responseUrl?: string | null
  status: number
  location?: string | null
}) {
  const request = new URL(normalizeHttpUrl(input.requestUrl, "admin request URL"))
  if (input.status === 401 || input.status === 403) {
    inspectResponseOrigin({ ...input, label: "admin" })
    return
  }
  if (input.status !== 302 || !input.location) {
    throw new Error(`admin endpoint is not protected: HTTP ${input.status}`)
  }

  const target = new URL(input.location, request)
  const accessHost = target.origin === request.origin || target.hostname.endsWith(".cloudflareaccess.com")
  if (target.protocol !== "https:" || !accessHost || !target.pathname.startsWith("/cdn-cgi/access/")) {
    throw new Error(`admin endpoint did not redirect to Cloudflare Access: ${target}`)
  }
}

export function inspectHtmlAssets(html: string, baseUrl: string, label: string) {
  const pageUrl = new URL(normalizeHttpUrl(baseUrl, `${label} base URL`))
  const tags = html.match(/<(?:link|script)\b[^>]*>/gi) ?? []
  const assets = tags.flatMap((tag) => {
    if (/^<script\b/i.test(tag)) {
      const type = attribute(tag, "type")?.trim().toLowerCase()
      const src = attribute(tag, "src")
      if (type !== "module" || !src) return []
      return [{ kind: "script" as const, url: new URL(src, pageUrl).toString() }]
    }

    const href = attribute(tag, "href")
    const rel = attribute(tag, "rel")
      ?.split(/\s+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
    if (!href || !rel?.length) return []

    const result: HtmlAssetContract[] = []
    if (rel.includes("stylesheet")) result.push({ kind: "stylesheet", url: new URL(href, pageUrl).toString() })
    if (rel.includes("modulepreload")) result.push({ kind: "modulepreload", url: new URL(href, pageUrl).toString() })
    return result
  })

  if (!assets.length) {
    throw new Error(`${label} did not reference any module scripts, stylesheets, or modulepreloads`)
  }

  return assets
}

export function inspectStaticAssetContentType(contentType: string | null, asset: HtmlAssetContract, label: string) {
  const mediaType = normalizedMediaType(contentType)
  if (!contentType) {
    throw new Error(`${label} is missing content-type`)
  }
  if (!mediaType) throw new Error(`${label} has a conflicting content-type: ${contentType}`)
  if (mediaType === "text/html") {
    throw new Error(`${label} returned HTML instead of ${asset.kind}`)
  }

  if (asset.kind === "stylesheet") {
    if (mediaType !== "text/css") {
      throw new Error(`${label} is not CSS: ${contentType}`)
    }
    return
  }

  if (!mediaType.includes("javascript") && !mediaType.includes("ecmascript")) {
    throw new Error(`${label} is not JavaScript: ${contentType}`)
  }
}

export function inspectConsoleHealth(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("console health response is not an object")
  }
  const body = value as { status?: unknown; service?: unknown }
  exactObjectKeys(body, ["status", "service"], "console health response")
  if (body.status !== "ok" || body.service !== "console") {
    throw new Error("console health response is not healthy")
  }
  return { status: "ok" as const, service: "console" as const }
}

export function inspectAuthHealth(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("auth health response is not an object")
  }
  const body = value as { status?: unknown; service?: unknown }
  exactObjectKeys(body, ["status", "service"], "auth health response")
  if (body.status !== "ok" || body.service !== "auth") {
    throw new Error("auth health response is not healthy")
  }
  return { status: "ok" as const, service: "auth" as const }
}

export function inspectAppHtml(html: string, appUrl?: string): AppRuntimeContract {
  if (!/<title>\s*MongolGPT\s*<\/title>/i.test(html)) throw new Error("MongolGPT title was not found")
  if (!/<div[^>]+id=["']root["']/i.test(html)) throw new Error("app root was not found")
  if (!/<script[^>]+type=["']module["'][^>]+src=["'][^"']+["']/i.test(html)) {
    throw new Error("app module script was not found")
  }

  const mode = meta(html, "mongolgpt-runtime-mode")
  if (mode !== "local-bridge" && mode !== "hosted") {
    throw new Error("app runtime metadata is missing or invalid")
  }

  const channel = meta(html, "mongolgpt-channel")
  if (channel !== "dev" && channel !== "beta" && channel !== "prod") {
    throw new Error("app channel metadata is missing or invalid")
  }

  const serverUrl = normalizeHttpUrl(meta(html, "mongolgpt-server-url") ?? "", "app server URL")
  const server = new URL(serverUrl)
  if (mode === "local-bridge" && server.hostname !== "localhost" && server.hostname !== "127.0.0.1") {
    throw new Error("local bridge runtime must use a loopback server")
  }
  if (mode === "hosted" && appUrl && server.origin === new URL(appUrl).origin) {
    throw new Error("hosted runtime cannot use the static app origin")
  }

  return { channel, mode, serverUrl }
}

export function inspectHostedAppRuntime(
  contract: AppRuntimeContract,
  expected: { channel: AppRuntimeContract["channel"]; runtimeHealthUrl: string },
) {
  if (contract.mode !== "hosted") throw new Error(`app runtime mode is ${contract.mode}; expected hosted`)
  if (contract.channel !== expected.channel) {
    throw new Error(`app channel is ${contract.channel}; expected ${expected.channel}`)
  }

  const actual = new URL(contract.serverUrl)
  if (actual.pathname !== "/" || actual.search !== "" || actual.hash !== "") {
    throw new Error(`hosted runtime URL must be an exact root URL: ${contract.serverUrl}`)
  }
  const expectedOrigin = new URL(expected.runtimeHealthUrl).origin
  const actualOrigin = actual.origin
  if (actualOrigin !== expectedOrigin) {
    throw new Error(`app runtime origin is ${actualOrigin}; expected ${expectedOrigin}`)
  }
}

export function inspectAnonymousHostedSession(value: unknown): AnonymousHostedSessionContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("hosted session response is not an object")
  }
  const body = value as { authenticated?: unknown; account?: unknown }
  if (body.authenticated !== false) throw new Error("hosted session response is not anonymous")
  if (body.account !== undefined) throw new Error("anonymous hosted session exposed account data")
  exactObjectKeys(body, ["authenticated"], "hosted session response")
  return { authenticated: false }
}

export function inspectAnonymousRuntimeApi(value: unknown): AnonymousRuntimeApiContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("anonymous runtime API response is not an object")
  }
  const body = value as { error?: unknown }
  exactObjectKeys(body, ["error"], "anonymous runtime API response")
  if (body.error !== "Нэвтэрч орно уу.") {
    throw new Error("anonymous runtime API response is not fail-closed")
  }
  return { error: "Нэвтэрч орно уу." }
}

export function inspectRuntimeHealth(
  value: unknown,
  expected: { stage: string; version: string },
): RuntimeHealthContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime health response is not an object")
  }
  const body = value as { healthy?: unknown; service?: unknown; stage?: unknown; version?: unknown }
  exactObjectKeys(body, ["healthy", "service", "stage", "version"], "runtime health response")
  if (body.healthy !== true || body.service !== "mongolgpt-runtime") {
    throw new Error("runtime health response is not healthy")
  }
  if (body.stage !== expected.stage) {
    throw new Error(`runtime stage is ${String(body.stage)}; expected ${expected.stage}`)
  }
  if (body.version !== expected.version) {
    throw new Error(`runtime version is ${String(body.version)}; expected ${expected.version}`)
  }
  return {
    healthy: true,
    service: "mongolgpt-runtime",
    stage: expected.stage,
    version: expected.version,
  }
}

export function inspectPaymentHealth(
  value: unknown,
  expectedEnvironment: PaymentHealthContract["environment"],
): PaymentHealthContract {
  if (typeof value !== "object" || value === null) throw new Error("payment health response is not an object")
  const body = value as {
    status?: unknown
    service?: unknown
    environment?: unknown
    providers?: unknown
    catalog?: unknown
    checkout?: unknown
    cancellation?: unknown
  }
  exactObjectKeys(
    body,
    ["catalog", "cancellation", "checkout", "environment", "providers", "service", "status"],
    "payment health response",
  )
  if (body.service !== "payments") throw new Error("payment health service is invalid")
  if (body.environment !== expectedEnvironment) {
    throw new Error(`payment environment is ${String(body.environment)}; expected ${expectedEnvironment}`)
  }
  if (typeof body.providers !== "object" || body.providers === null) {
    throw new Error("payment provider health is missing")
  }

  const providers = body.providers as { qpay?: unknown; bonum?: unknown }
  if (expectedEnvironment === "disabled") {
    if (
      body.status !== "disabled" ||
      providers.qpay !== false ||
      providers.bonum !== false ||
      body.catalog !== false ||
      body.checkout !== false ||
      body.cancellation !== false
    ) {
      throw new Error("disabled payment service exposes an enabled capability")
    }
    return { status: "disabled", environment: expectedEnvironment }
  }

  if (
    body.status !== "ok" ||
    providers.qpay !== true ||
    providers.bonum !== true ||
    body.catalog !== true ||
    body.checkout !== true ||
    body.cancellation !== true
  ) {
    throw new Error("enabled payment service is not fully ready")
  }
  return { status: "ok", environment: expectedEnvironment }
}

export function inspectSmokeAuthCookie(value: string | undefined) {
  if (!value) throw new Error("MONGOLGPT_SMOKE_AUTH_COOKIE дутуу байна.")
  if (value.length > 4_096 || value.trim() !== value) {
    throw new Error("MONGOLGPT_SMOKE_AUTH_COOKIE-ийн урт эсвэл захын хоосон тэмдэг буруу байна.")
  }
  if (!value.startsWith("__Host-mongolgpt-auth=")) {
    throw new Error("MONGOLGPT_SMOKE_AUTH_COOKIE нь __Host-mongolgpt-auth cookie байна.")
  }

  const token = value.slice("__Host-mongolgpt-auth=".length)
  if (token.length < 16 || !/^[\x21-\x7e]+$/.test(token) || /[;,"\\]/.test(token)) {
    throw new Error("MONGOLGPT_SMOKE_AUTH_COOKIE нь зөвхөн cookie-ийн нэр ба нууц утгыг агуулна.")
  }
  return value
}

export function inspectAuthenticatedAccountOverview(value: unknown): AuthenticatedSmokeAccount {
  const body = record(value, "authenticated account overview")
  exactObjectKeys(body, ["account", "currentWorkspaceID", "workspaces"], "authenticated account overview")
  const account = record(body.account, "authenticated account")
  if (
    typeof account.id !== "string" ||
    !/^acc_[A-Za-z0-9_-]+$/.test(account.id) ||
    typeof account.email !== "string" ||
    account.email.length > 320 ||
    account.email.trim() !== account.email ||
    account.status !== "active"
  ) {
    throw new Error("authenticated account overview does not contain an active account")
  }
  if (typeof body.currentWorkspaceID !== "string" || !/^wrk_[A-Za-z0-9_-]+$/.test(body.currentWorkspaceID)) {
    throw new Error("authenticated account overview has no current workspace")
  }
  if (!Array.isArray(body.workspaces)) throw new Error("authenticated account overview workspaces are invalid")

  const workspace = body.workspaces.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item) && item.id === body.currentWorkspaceID,
  )
  if (!workspace) throw new Error("authenticated account overview does not include the current workspace")
  const limits = record(workspace.limits, "authenticated account workspace limits")
  if (limits.plan !== "free" || workspace.subscription !== null) {
    throw new Error("authenticated smoke identity must use the Free plan")
  }

  return {
    accountID: account.id,
    email: account.email,
    workspaceID: body.currentWorkspaceID,
  }
}

export function inspectAuthenticatedRuntimeToken(
  value: unknown,
  expected: { accountID: string; email: string },
  now = Date.now(),
): AuthenticatedRuntimeToken {
  const body = record(value, "authenticated runtime token")
  exactObjectKeys(body, ["account", "expiresAt", "token"], "authenticated runtime token")
  const account = record(body.account, "authenticated runtime token account")
  exactObjectKeys(account, ["email", "id"], "authenticated runtime token account")
  if (account.id !== expected.accountID || account.email !== expected.email) {
    throw new Error("authenticated runtime token account does not match the smoke account")
  }
  if (typeof body.token !== "string" || body.token.length > 4_096 || !/^[A-Za-z0-9._-]+$/.test(body.token)) {
    throw new Error("authenticated runtime token is invalid")
  }
  if (!shortLivedExpiry(body.expiresAt, now)) {
    throw new Error("authenticated runtime token expiry is invalid")
  }
  return { token: body.token, expiresAt: body.expiresAt, accountID: expected.accountID }
}

export function inspectRuntimeSessionCookie(value: string | null, token: string) {
  if (!value) throw new Error("authenticated runtime session did not set a cookie")
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = value.match(
    new RegExp(`^__Host-mongolgpt-runtime=${escaped}; Max-Age=([1-9]\\d*); Path=/; Secure; HttpOnly; SameSite=Strict$`),
  )
  const maxAge = Number(match?.[1])
  if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 90 || value.includes("Domain=")) {
    throw new Error("authenticated runtime session cookie is not host-only and short-lived")
  }
  return `__Host-mongolgpt-runtime=${token}`
}

export function inspectAuthenticatedRuntimeSession(
  value: unknown,
  expected: { accountID: string; maximumExpiresAt: number },
  now = Date.now(),
) {
  const body = record(value, "authenticated runtime session")
  exactObjectKeys(body, ["account", "authenticated", "expiresAt"], "authenticated runtime session")
  const account = record(body.account, "authenticated runtime session account")
  exactObjectKeys(account, ["id"], "authenticated runtime session account")
  if (body.authenticated !== true || account.id !== expected.accountID) {
    throw new Error("authenticated runtime session account does not match the smoke account")
  }
  if (!shortLivedExpiry(body.expiresAt, now) || body.expiresAt > expected.maximumExpiresAt) {
    throw new Error("authenticated runtime session expiry is invalid")
  }
  return { authenticated: true as const, accountID: expected.accountID, expiresAt: body.expiresAt }
}

export function inspectAuthenticatedRuntimeProjects(value: unknown) {
  if (!Array.isArray(value)) throw new Error("authenticated runtime project response is not an array")
  for (const item of value) {
    const project = record(item, "authenticated runtime project")
    if (typeof project.id !== "string" || !project.id.trim()) {
      throw new Error("authenticated runtime project has no id")
    }
  }
  return value.length
}

export function inspectAuthenticatedFreeAutoProvider(value: unknown) {
  const body = record(value, "authenticated runtime provider response")
  exactObjectKeys(body, ["all", "connected", "default"], "authenticated runtime provider response")
  if (!Array.isArray(body.all) || !Array.isArray(body.connected)) {
    throw new Error("authenticated runtime provider response has invalid lists")
  }
  record(body.default, "authenticated runtime default models")
  if (!body.connected.includes("mongolgpt")) {
    throw new Error("authenticated runtime is not connected to the MongolGPT provider")
  }

  const providers = body.all.map((item) => record(item, "authenticated runtime provider"))
  if (providers.some((provider) => ["opencode", "opencode-go", "mongolgpt-go"].includes(String(provider.id)))) {
    throw new Error("authenticated runtime provider response exposes a legacy hosted provider")
  }
  const provider = providers.find((item) => item.id === "mongolgpt")
  if (!provider || provider.name !== "MongolGPT") {
    throw new Error("authenticated runtime provider response has no MongolGPT provider")
  }
  const models = record(provider.models, "authenticated MongolGPT provider models")
  const freeAuto = record(models["free-auto"], "authenticated Free Auto model")
  if (freeAuto.id !== "free-auto" || freeAuto.name !== "MongolGPT Free Auto") {
    throw new Error("authenticated runtime provider response has no Free Auto model")
  }
  return { providerID: "mongolgpt" as const, modelID: "free-auto" as const }
}

export function inspectAuthenticatedRuntimeSessionCreate(value: unknown) {
  const session = record(value, "authenticated runtime session create response")
  if (typeof session.id !== "string" || !/^ses_[A-Za-z0-9_-]+$/.test(session.id)) {
    throw new Error("authenticated runtime session create response has no valid session id")
  }
  if (session.directory !== "/workspace") {
    throw new Error("authenticated runtime session was not created in the isolated workspace")
  }
  return { sessionID: session.id }
}

export function inspectAuthenticatedFreeAutoResponse(value: unknown, sessionID: string) {
  const response = record(value, "authenticated Free Auto response")
  exactObjectKeys(response, ["info", "parts"], "authenticated Free Auto response")
  const info = record(response.info, "authenticated Free Auto response info")
  if (
    info.sessionID !== sessionID ||
    info.role !== "assistant" ||
    info.providerID !== "mongolgpt" ||
    info.modelID !== "free-auto" ||
    info.error !== undefined
  ) {
    throw new Error("authenticated Free Auto response identity is invalid")
  }
  const time = record(info.time, "authenticated Free Auto response time")
  const tokens = record(info.tokens, "authenticated Free Auto response usage")
  if (
    typeof time.completed !== "number" ||
    !Number.isFinite(time.completed) ||
    typeof info.finish !== "string" ||
    !info.finish.trim() ||
    typeof info.cost !== "number" ||
    !Number.isFinite(info.cost) ||
    info.cost < 0 ||
    typeof tokens.output !== "number" ||
    !Number.isInteger(tokens.output) ||
    tokens.output < 1
  ) {
    throw new Error("authenticated Free Auto response has no completed usage evidence")
  }
  if (!Array.isArray(response.parts)) throw new Error("authenticated Free Auto response parts are invalid")
  const output = response.parts
    .filter(
      (part): part is Record<string, unknown> => typeof part === "object" && part !== null && !Array.isArray(part),
    )
    .filter((part) => part.type === "text" && part.sessionID === sessionID && part.messageID === info.id)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim()
  if (!output.includes("MONGOLGPT_SMOKE_READY")) {
    throw new Error("authenticated Free Auto response did not contain the smoke marker")
  }
  return { providerID: "mongolgpt" as const, modelID: "free-auto" as const, output }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value as Record<string, unknown>
}

function shortLivedExpiry(value: unknown, now: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > now &&
    value <= now + 125_000
  )
}
