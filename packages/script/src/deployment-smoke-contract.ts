export type AppRuntimeContract = {
  channel: "dev" | "beta" | "prod"
  mode: "local-bridge" | "hosted"
  serverUrl: string
}

export type AnonymousHostedSessionContract = {
  authenticated: false
}

export type PaymentHealthContract = {
  status: "disabled" | "ok"
  environment: "disabled" | "sandbox" | "production"
}

export function inspectHtmlContentType(contentType: string | null, label: string) {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "text/html") {
    throw new Error(`${label} is not HTML: ${contentType || "missing content-type"}`)
  }
}

export function inspectJsonApiPayload(contentType: string | null, payload: string, label: string): unknown {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") {
    throw new Error(`${label} is not JSON: ${contentType || "missing content-type"}`)
  }

  if (/^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(payload)) {
    throw new Error(`${label} returned an HTML/static shell instead of JSON`)
  }

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
  return { authenticated: false }
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
