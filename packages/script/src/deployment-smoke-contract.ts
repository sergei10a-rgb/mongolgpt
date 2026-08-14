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
