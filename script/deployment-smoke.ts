import { deploymentEndpoints, preflightDeployment } from "@mongolgpt/script/deployment"
import type { DeploymentPreflightResult } from "@mongolgpt/script/deployment"
import {
  inspectAdminProtection,
  inspectAuthenticatedAccountOverview,
  inspectAuthenticatedFreeAutoResponse,
  inspectAuthenticatedFreeAutoProvider,
  inspectAuthenticatedRuntimeProjects,
  inspectAuthenticatedRuntimeSessionCreate,
  inspectAuthenticatedRuntimeSession,
  inspectAuthenticatedRuntimeToken,
  inspectAuthHealth,
  inspectConsoleHealth,
  inspectDeploymentEndpointConfiguration,
  inspectDocsRootRedirect,
  inspectAnonymousHostedSession,
  inspectAnonymousRuntimeApi,
  inspectAppHtml,
  inspectHtmlAssets,
  inspectHostedAppRelease,
  inspectHostedAppRuntime,
  inspectHtmlContentType,
  inspectJsonApiPayload,
  inspectPaymentHealth,
  inspectResponseOrigin,
  inspectRuntimeSessionCookie,
  inspectSmokeAuthCookie,
  inspectStaticAssetContentType,
  inspectRuntimeHealth,
} from "@mongolgpt/script/deployment-smoke-contract"
import { isStaticAppBackendPath } from "../packages/app/src/utils/static-app-router"

if (import.meta.main) {
  if (process.argv[2] === "--validate-auth-cookie") {
    inspectSmokeAuthCookie(process.env.MONGOLGPT_SMOKE_AUTH_COOKIE)
    console.log("Authenticated deployment smoke identity is configured.")
  } else if (process.argv[2] === "--auth-bootstrap") {
    await runAuthBootstrapSmoke(process.argv[3])
  } else if (process.argv[2] === "--docs-only") {
    await runDocsSmoke(process.argv[3])
  } else if (process.argv[2] === "--app-only") {
    await runAppSmoke(process.argv[3])
  } else if (process.argv[2] === "--runtime-only") {
    await runRuntimeSmoke(process.argv[3])
  } else {
    await runSmoke()
  }
}

export async function runDocsSmoke(stage = process.env.SST_STAGE ?? "dev") {
  if (stage !== "dev") throw new Error("Docs-only smoke нь зөвхөн dev орчинд ажиллана.")
  if (process.env.MONGOLGPT_ENABLE_HOSTED_SERVICES === "true") {
    throw new Error("Docs-only smoke нь hosted service тохиргоо ашиглахгүй.")
  }

  const result = preflightDeployment({
    stage,
    env: process.env,
    requireCloudflareCredentials: false,
    requireDeploymentSecrets: false,
    scope: "docs-only",
  })
  const endpoints = deploymentEndpoints(result)
  inspectDeploymentEndpointConfiguration(endpoints, result)
  await check("docs", endpoints.docs, undefined, result, endpoints.app, "")
  console.log("Dev docs-only smoke check passed.")
}

export async function runAppSmoke(stage = process.env.SST_STAGE ?? "dev") {
  if (stage !== "dev") throw new Error("App-only smoke нь зөвхөн dev орчинд ажиллана.")
  if (process.env.MONGOLGPT_ENABLE_HOSTED_SERVICES !== "true") {
    throw new Error("App-only smoke нь hosted service тохиргоо шаардана.")
  }

  const result = preflightDeployment({
    stage,
    env: process.env,
    requireCloudflareCredentials: false,
    requireDeploymentSecrets: false,
    requireHostedServices: true,
    scope: "app-only",
  })
  const endpoints = deploymentEndpoints(result)
  inspectDeploymentEndpointConfiguration(endpoints, result)
  await check("app", endpoints.app, undefined, result, endpoints.app, "", { staticAppOnly: true })
  console.log("Dev app-only smoke check passed.")
}

export async function runRuntimeSmoke(stage = process.env.SST_STAGE ?? "dev") {
  if (stage !== "dev") throw new Error("Runtime-only smoke нь зөвхөн dev орчинд ажиллана.")
  if (process.env.MONGOLGPT_ENABLE_HOSTED_SERVICES !== "true") {
    throw new Error("Runtime-only smoke нь hosted service тохиргоо шаардана.")
  }

  const result = preflightDeployment({
    stage,
    env: process.env,
    requireCloudflareCredentials: false,
    requireDeploymentSecrets: false,
    requireHostedServices: true,
    scope: "runtime-only",
  })
  const endpoints = deploymentEndpoints(result)
  inspectDeploymentEndpointConfiguration(endpoints, result)
  if (!endpoints.runtimeHealth) throw new Error("Runtime-only smoke health endpoint дутуу байна.")

  const runtimeVersion = await expectedRuntimeVersion()
  const runtimeOrigin = new URL(endpoints.runtimeHealth).origin
  await check("runtimeHealth", endpoints.runtimeHealth, "runtime", result, endpoints.app, runtimeVersion)
  await checkHostedSessionBoundary(runtimeOrigin, endpoints.app)
  await checkAnonymousRuntimeApiBoundary(runtimeOrigin, endpoints.app)
  console.log("Dev runtime-only smoke check passed. Authenticated account болон Free Auto урсгалыг full smoke шалгана.")
}

export async function runAuthBootstrapSmoke(stage = process.env.SST_STAGE ?? "dev") {
  if (stage !== "dev") throw new Error("OAuth bootstrap smoke нь зөвхөн dev орчинд ажиллана.")

  const result = preflightDeployment({
    stage,
    env: process.env,
    requireCloudflareCredentials: false,
    requireDeploymentSecrets: false,
    requireHostedServices: true,
  })
  const endpoints = deploymentEndpoints(result)
  inspectDeploymentEndpointConfiguration(endpoints, result)
  if (!endpoints.console || !endpoints.consoleHealth || !endpoints.authHealth) {
    throw new Error("OAuth bootstrap smoke endpoint-үүд дутуу байна.")
  }

  const runtimeVersion = await expectedRuntimeVersion()
  await check("consoleHealth", endpoints.consoleHealth, "console", result, endpoints.app, runtimeVersion)
  await check("authHealth", endpoints.authHealth, "auth", result, endpoints.app, runtimeVersion)
  await check("console", endpoints.console, undefined, result, endpoints.app, runtimeVersion)
  console.log(
    "Dev account scaffold smoke check passed. OAuth callback болон authenticated runtime урсгалыг тусад нь шалгана.",
  )
}

async function runSmoke() {
  const smokeAuthCookie = inspectSmokeAuthCookie(process.env.MONGOLGPT_SMOKE_AUTH_COOKIE)
  const result = preflightDeployment({
    stage: process.argv[2] ?? process.env.SST_STAGE ?? "dev",
    env: process.env,
    requireCloudflareCredentials: false,
    requireDeploymentSecrets: false,
    requireHostedServices: true,
  })
  const endpoints = deploymentEndpoints(result)
  inspectDeploymentEndpointConfiguration(endpoints, result)
  const runtimeVersion = await expectedRuntimeVersion()
  const healthContracts = new Map(
    [
      [endpoints.consoleHealth, "console"],
      [endpoints.authHealth, "auth"],
      [endpoints.runtimeHealth, "runtime"],
      [endpoints.paymentHealth, "payment"],
      [endpoints.admin, "admin"],
    ].filter((entry): entry is [string, "console" | "auth" | "runtime" | "payment" | "admin"] => Boolean(entry[0])),
  )

  for (const [name, url] of Object.entries(endpoints)) {
    await check(name, url, healthContracts.get(url), result, endpoints.app, runtimeVersion)
  }

  if (!endpoints.console || !endpoints.runtimeHealth) {
    throw new Error("Hosted authentication smoke endpoints are missing.")
  }
  await checkAuthenticatedHostedFlow({
    consoleUrl: endpoints.console,
    appUrl: endpoints.app,
    runtimeUrl: new URL(endpoints.runtimeHealth).origin,
    authCookie: smokeAuthCookie,
  })

  console.log("Cloudflare deployment smoke check passed.")
}

async function check(
  name: string,
  url: string,
  health: "console" | "auth" | "runtime" | "payment" | "admin" | undefined,
  result: DeploymentPreflightResult,
  appUrl: string,
  runtimeVersion: string,
  options: { staticAppOnly?: boolean } = {},
) {
  const retries = positiveInteger(process.env.MONGOLGPT_SMOKE_RETRIES, 8)
  const delay = positiveInteger(process.env.MONGOLGPT_SMOKE_DELAY_MS, 10_000)
  let lastError: unknown

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "mongolgpt-deployment-smoke" },
        redirect: health === "admin" ? "manual" : "follow",
        signal: AbortSignal.timeout(15_000),
      })
      if (health === "admin") {
        inspectAdminProtection({
          requestUrl: url,
          responseUrl: response.url,
          status: response.status,
          location: response.headers.get("location"),
        })
      } else {
        inspectResponseOrigin({
          requestUrl: url,
          responseUrl: response.url,
          status: response.status,
          location: response.headers.get("location"),
          label: name,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      }
      if (health && health !== "admin") {
        inspectNoStoreResponse(response, `${health} health response`)
        const body = inspectJsonApiPayload(
          response.headers.get("content-type"),
          await response.text(),
          `${health} health response`,
        )
        if (health === "console") inspectConsoleHealth(body)
        if (health === "auth") inspectAuthHealth(body)
        if (health === "runtime") inspectRuntimeHealth(body, { stage: result.stage, version: runtimeVersion })
        if (health === "payment") inspectPaymentHealth(body, result.paymentEnvironment)
      } else if (name === "console") {
        await checkHostedRuntimeToken(url, appUrl)
        await checkHostedAccountOverview(url, appUrl)
        const authHealthUrl = deploymentEndpoints(result).authHealth
        if (!authHealthUrl) throw new Error("hosted auth endpoint is missing")
        await checkHostedAuthorize(url, new URL(authHealthUrl).origin, result.turnstileEnabled)
      } else if (name === "docs") {
        inspectHtmlContentType(response.headers.get("content-type"), "docs response")
        const html = await response.text()
        await checkStaticAssets(url, html, "docs response")
        await checkDocsRoot(url)
      } else if (name === "app") {
        inspectHtmlContentType(response.headers.get("content-type"), "app response")
        const html = await response.text()
        const contract = inspectAppDeployment(html, url, result)
        await checkStaticAssets(url, html, "app response")
        if (contract.mode === "hosted") {
          const runtimeHealthUrl = deploymentEndpoints(result).runtimeHealth
          if (!runtimeHealthUrl) throw new Error("hosted app runtime endpoint is missing")
          inspectHostedAppRuntime(contract, { channel: appChannel(result), runtimeHealthUrl })
          if (!options.staticAppOnly) {
            await checkAgentRuntime(contract.serverUrl, result.stage, runtimeVersion)
            await checkHostedSessionBoundary(contract.serverUrl, url)
            await checkAnonymousRuntimeApiBoundary(contract.serverUrl, url)
          }
        }
        await checkDirectAppRoute(url, result)
        await checkStaticAppBackendBoundary(url)
      } else {
        await response.body?.cancel()
      }
      console.log(`OK ${name}: ${url}`)
      return
    } catch (error) {
      lastError = error
      console.warn(`WAIT ${name} (${attempt}/${retries}): ${error instanceof Error ? error.message : String(error)}`)
      if (attempt < retries) await Bun.sleep(delay)
    }
  }

  throw new Error(`${name} smoke check failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function checkDocsRoot(docsUrl: string) {
  const rootUrl = new URL("/", docsUrl).toString()
  const response = await fetch(rootUrl, {
    headers: { "User-Agent": "mongolgpt-deployment-smoke" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  inspectResponseOrigin({
    requestUrl: rootUrl,
    responseUrl: response.url,
    status: response.status,
    location: response.headers.get("location"),
    label: "docs root",
  })
  inspectDocsRootRedirect({
    docsUrl,
    status: response.status,
    contentType: response.headers.get("content-type"),
    location: response.headers.get("location"),
    body: await response.text(),
  })
}

function inspectAppDeployment(html: string, url: string, result: DeploymentPreflightResult) {
  const contract = inspectAppHtml(html, url)
  const expectedChannel = appChannel(result)
  if (contract.channel !== expectedChannel) {
    throw new Error(`app channel is ${contract.channel}; expected ${expectedChannel}`)
  }
  const expectedMode = result.hostedServices ? "hosted" : "local-bridge"
  if (contract.mode !== expectedMode) {
    throw new Error(`app runtime mode is ${contract.mode}; expected ${expectedMode}`)
  }
  if (result.hostedServices) inspectHostedAppRelease(html, requiredReleaseSha())
  return contract
}

function requiredReleaseSha() {
  const value = process.env.MONGOLGPT_RELEASE_SHA?.trim()
  if (!value) throw new Error("MONGOLGPT_RELEASE_SHA дутуу байна.")
  return value
}

function appChannel(result: DeploymentPreflightResult) {
  return result.stage === "production" ? "prod" : result.stage === "dev" ? "dev" : "beta"
}

async function checkDirectAppRoute(appUrl: string, result: DeploymentPreflightResult) {
  const directUrl = new URL("/new-session", `${appUrl}/`).toString()
  const response = await fetch(directUrl, {
    headers: { "User-Agent": "mongolgpt-deployment-smoke" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  })
  inspectResponseOrigin({
    requestUrl: directUrl,
    responseUrl: response.url,
    status: response.status,
    location: response.headers.get("location"),
    label: "app direct navigation",
  })
  if (!response.ok) throw new Error(`app direct navigation HTTP ${response.status}: ${directUrl}`)
  inspectHtmlContentType(response.headers.get("content-type"), "app direct navigation")
  const html = await response.text()
  inspectAppDeployment(html, directUrl, result)
  await checkStaticAssets(directUrl, html, "app direct navigation")
}

async function checkStaticAppBackendBoundary(appUrl: string) {
  for (const path of [
    "/api/health",
    "/global/health",
    "/v1/account/overview",
    "/auth/runtime-token",
    "/auth/session",
    "/session",
    "/provider",
    "/project",
  ]) {
    if (!isStaticAppBackendPath(path)) throw new Error(`static app backend path is not reserved: ${path}`)
    const requestUrl = new URL(path, `${appUrl}/`).toString()
    const response = await fetch(requestUrl, {
      headers: { Accept: "application/json", "User-Agent": "mongolgpt-deployment-smoke" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
    inspectResponseOrigin({
      requestUrl,
      responseUrl: response.url,
      status: response.status,
      location: response.headers.get("location"),
      label: "static app backend boundary",
    })
    await inspectStaticAppBackendRejection(response, path)
  }
}

export async function inspectStaticAppBackendRejection(response: Response, path: string) {
  if (response.status !== 404) throw new Error(`static app ${path} HTTP ${response.status}; expected 404`)
  inspectNoStoreResponse(response, `static app ${path}`)
  if (response.headers.get("x-content-type-options")?.toLowerCase() !== "nosniff") {
    throw new Error(`static app ${path} x-content-type-options is not nosniff`)
  }
  const body = inspectJsonApiPayload(response.headers.get("content-type"), await response.text(), `static app ${path}`)
  if (!body || typeof body !== "object" || !("code" in body) || body.code !== "STATIC_APP_API_ROUTE") {
    throw new Error(`static app ${path} returned the wrong error contract`)
  }
}

async function checkHostedAuthorize(consoleUrl: string, authOrigin: string, turnstileEnabled: boolean) {
  const requestUrl = new URL("/auth/authorize?continue=/auth/app", `${consoleUrl}/`).toString()
  const response = await fetch(requestUrl, {
    headers: { "User-Agent": "mongolgpt-deployment-smoke" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  if (turnstileEnabled) {
    inspectHostedAuthorizeChallenge({
      requestUrl,
      authOrigin,
      responseUrl: response.url,
      status: response.status,
      location: response.headers.get("location"),
      contentType: response.headers.get("content-type"),
      cacheControl: response.headers.get("cache-control"),
      contentSecurityPolicy: response.headers.get("content-security-policy"),
      frameOptions: response.headers.get("x-frame-options"),
      body: await response.text(),
    })
    await checkHostedTurnstileRejection(consoleUrl, authOrigin)
    return
  }
  inspectHostedAuthorizeRedirect({
    requestUrl,
    responseUrl: response.url,
    status: response.status,
    location: response.headers.get("location"),
    authOrigin,
  })
  await response.body?.cancel()
}

async function checkHostedTurnstileRejection(consoleUrl: string, authOrigin: string) {
  const direct = new URL("/authorize", `${authOrigin}/`)
  direct.search = new URLSearchParams({
    client_id: "app",
    redirect_uri: new URL("/auth/callback/auth/app", `${consoleUrl}/`).toString(),
    response_type: "code",
    state: "deployment-smoke-direct-auth",
  }).toString()
  const response = await fetch(direct, {
    headers: { Accept: "application/json", "User-Agent": "mongolgpt-deployment-smoke" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  const body = inspectJsonApiPayload(
    response.headers.get("content-type"),
    await response.text(),
    "direct auth gate response",
  )
  inspectHostedTurnstileRejection({
    requestUrl: direct.toString(),
    responseUrl: response.url,
    status: response.status,
    location: response.headers.get("location"),
    cacheControl: response.headers.get("cache-control"),
    body,
  })
}

export function inspectHostedTurnstileRejection(input: {
  requestUrl: string
  responseUrl?: string | null
  status: number
  location?: string | null
  cacheControl?: string | null
  body: unknown
}) {
  const request = new URL(input.requestUrl)
  if (input.responseUrl && new URL(input.responseUrl).origin !== request.origin) {
    throw new Error("direct auth gate response left the auth origin")
  }
  if (input.status !== 403 || input.location) {
    throw new Error(`direct auth gate returned HTTP ${input.status}; expected 403`)
  }
  if (input.cacheControl !== "no-store") throw new Error("direct auth gate response must not be cached")
  if (typeof input.body !== "object" || input.body === null || Array.isArray(input.body)) {
    throw new Error("direct auth gate response is not an object")
  }
  const body = input.body as { error?: unknown; message?: unknown }
  if (Object.keys(body).sort().join(",") !== "error,message") {
    throw new Error("direct auth gate response shape is invalid")
  }
  if (
    body.error !== "turnstile_required" ||
    body.message !== "Нэвтрэхийн өмнө Cloudflare Turnstile баталгаажуулалт шаардлагатай."
  ) {
    throw new Error("direct auth gate did not fail closed")
  }
}

export function inspectHostedAuthorizeChallenge(input: {
  requestUrl: string
  authOrigin: string
  responseUrl?: string | null
  status: number
  location?: string | null
  contentType?: string | null
  cacheControl?: string | null
  contentSecurityPolicy?: string | null
  frameOptions?: string | null
  body: string
}) {
  const request = new URL(input.requestUrl)
  const expectedAuth = new URL(input.authOrigin)
  if (request.protocol !== "https:") throw new Error("hosted authorization URL must use HTTPS")
  if (input.responseUrl && new URL(input.responseUrl).origin !== request.origin) {
    throw new Error("hosted authorization challenge left the console origin")
  }
  if (input.status !== 200 || input.location) {
    throw new Error(`hosted authorization challenge returned HTTP ${input.status}; expected a local HTML challenge`)
  }
  inspectHtmlContentType(input.contentType ?? null, "hosted authorization challenge")
  if (input.cacheControl !== "no-store") throw new Error("hosted authorization challenge must not be cached")
  if (input.frameOptions !== "DENY") throw new Error("hosted authorization challenge can be framed")

  const csp = input.contentSecurityPolicy ?? ""
  for (const required of [
    "script-src https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    `form-action ${expectedAuth.origin}`,
    "object-src 'none'",
  ]) {
    if (!csp.includes(required)) throw new Error(`hosted authorization challenge CSP is missing ${required}`)
  }

  if (!/<html\s+lang=["']mn["']/i.test(input.body)) {
    throw new Error("hosted authorization challenge is not Mongolian")
  }
  if (!/https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/i.test(input.body)) {
    throw new Error("hosted authorization challenge is missing the Cloudflare widget")
  }
  if (!/data-sitekey=["'][A-Za-z0-9_-]{20,64}["']/i.test(input.body)) {
    throw new Error("hosted authorization challenge site key is missing")
  }
  if (!/data-action=["']mongolgpt_login["']/i.test(input.body)) {
    throw new Error("hosted authorization challenge action is invalid")
  }
  const formAction = input.body.match(/<form[^>]+action=["']([^"']+)["'][^>]+method=["']post["']/i)?.[1]
  if (!formAction || new URL(formAction).toString() !== `${expectedAuth.origin}/authorize`) {
    throw new Error("hosted authorization challenge form is invalid")
  }
  const clientID = hiddenInputValue(input.body, "client_id")
  if (clientID !== "app") throw new Error("hosted authorization challenge client ID is invalid")
  const redirectURI = hiddenInputValue(input.body, "redirect_uri")
  const expectedCallback = new URL("/auth/callback/auth/app", request.origin).toString()
  if (redirectURI !== expectedCallback) throw new Error("hosted authorization challenge callback is invalid")
  const responseType = hiddenInputValue(input.body, "response_type")
  if (responseType !== "code") throw new Error("hosted authorization challenge response type is invalid")
  const state = hiddenInputValue(input.body, "state")
  if (!state || !/^[A-Za-z0-9_-]{32,256}$/.test(state)) {
    throw new Error("hosted authorization challenge state is invalid")
  }
}

function hiddenInputValue(body: string, name: string) {
  const values: string[] = []
  for (const match of body.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0]
    if (htmlAttribute(tag, "name") !== name) continue
    const value = htmlAttribute(tag, "value")
    if (value !== undefined) values.push(value)
  }
  return values.length === 1 ? values[0] : undefined
}

function htmlAttribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))
  return match?.[2]
    ?.replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
}

export function inspectHostedAuthorizeRedirect(input: {
  requestUrl: string
  responseUrl?: string | null
  status: number
  location?: string | null
  authOrigin: string
}) {
  const request = new URL(input.requestUrl)
  const expectedAuth = new URL(input.authOrigin)
  if (request.protocol !== "https:" || expectedAuth.protocol !== "https:") {
    throw new Error("hosted authorization URLs must use HTTPS")
  }
  if (input.responseUrl && new URL(input.responseUrl).origin !== request.origin) {
    throw new Error("hosted authorization response left the console origin")
  }
  if (input.status !== 302 || !input.location) {
    throw new Error(`hosted authorization returned HTTP ${input.status}; expected a redirect`)
  }

  const target = new URL(input.location, request)
  if (target.origin !== expectedAuth.origin || target.pathname !== "/authorize") {
    throw new Error(`hosted authorization did not redirect to the auth worker: ${target}`)
  }
  if (target.searchParams.get("client_id") !== "app") {
    throw new Error("hosted authorization client ID is not app")
  }

  const callbackValue = target.searchParams.get("redirect_uri")
  if (!callbackValue) throw new Error("hosted authorization callback is missing")
  const callback = new URL(callbackValue)
  const expectedCallback = new URL("/auth/callback/auth/app", request.origin)
  if (callback.toString() !== expectedCallback.toString()) {
    throw new Error(`hosted authorization callback is invalid: ${callback}`)
  }
}

async function checkHostedRuntimeToken(consoleUrl: string, appUrl: string) {
  const tokenUrl = new URL("/auth/runtime-token", `${consoleUrl}/`)
  const appOrigin = new URL(appUrl).origin
  const preflight = await fetch(tokenUrl, {
    method: "OPTIONS",
    headers: {
      Origin: appOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
      "User-Agent": "mongolgpt-deployment-smoke",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  inspectResponseOrigin({
    requestUrl: tokenUrl.toString(),
    responseUrl: preflight.url,
    status: preflight.status,
    location: preflight.headers.get("location"),
    label: "runtime token preflight",
  })
  inspectRuntimeTokenPreflight(preflight, appOrigin)

  const anonymous = await fetch(tokenUrl, {
    method: "POST",
    credentials: "omit",
    headers: {
      Accept: "application/json",
      Origin: appOrigin,
      "User-Agent": "mongolgpt-deployment-smoke",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  inspectResponseOrigin({
    requestUrl: tokenUrl.toString(),
    responseUrl: anonymous.url,
    status: anonymous.status,
    location: anonymous.headers.get("location"),
    label: "anonymous runtime token",
  })
  await inspectAnonymousRuntimeToken(anonymous, appOrigin)
}

export function inspectRuntimeTokenPreflight(response: Response, appOrigin: string) {
  if (response.status !== 204) {
    throw new Error(`runtime token preflight returned HTTP ${response.status}; expected 204`)
  }
  inspectCredentialedCors(response, appOrigin, "runtime token")
  if (response.headers.get("access-control-allow-methods") !== "POST, OPTIONS") {
    throw new Error("runtime token preflight methods are not exact")
  }
  if (response.headers.get("access-control-allow-headers") !== "Content-Type") {
    throw new Error("runtime token preflight headers are not exact")
  }
  if (response.headers.get("access-control-max-age") !== "600") {
    throw new Error("runtime token preflight max age is not exact")
  }
}

export async function inspectAnonymousRuntimeToken(response: Response, appOrigin: string) {
  if (response.status !== 401) {
    throw new Error(`anonymous runtime token request returned HTTP ${response.status}; expected 401`)
  }
  inspectCredentialedCors(response, appOrigin, "runtime token")
  const body = inspectJsonApiPayload(
    response.headers.get("content-type"),
    await response.text(),
    "anonymous runtime token response",
  )
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    (body as { error?: unknown }).error !== "unauthorized" ||
    (body as { message?: unknown }).message !== "MongolGPT бүртгэлээр нэвтэрнэ үү."
  ) {
    throw new Error("anonymous runtime token response is not fail-closed")
  }
}

async function checkHostedAccountOverview(consoleUrl: string, appUrl: string) {
  const overviewUrl = new URL("/v1/account/overview", `${consoleUrl}/`)
  const appOrigin = new URL(appUrl).origin
  const preflight = await fetch(overviewUrl, {
    method: "OPTIONS",
    headers: {
      Origin: appOrigin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization, x-org-id",
      "User-Agent": "mongolgpt-deployment-smoke",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  inspectResponseOrigin({
    requestUrl: overviewUrl.toString(),
    responseUrl: preflight.url,
    status: preflight.status,
    location: preflight.headers.get("location"),
    label: "account overview preflight",
  })
  inspectAccountOverviewPreflight(preflight, appOrigin)

  const anonymous = await fetch(overviewUrl, {
    credentials: "omit",
    headers: {
      Accept: "application/json",
      Origin: appOrigin,
      "User-Agent": "mongolgpt-deployment-smoke",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  inspectResponseOrigin({
    requestUrl: overviewUrl.toString(),
    responseUrl: anonymous.url,
    status: anonymous.status,
    location: anonymous.headers.get("location"),
    label: "anonymous account overview",
  })
  await inspectAnonymousAccountOverview(anonymous, appOrigin)
}

export function inspectAccountOverviewPreflight(response: Response, appOrigin: string) {
  if (response.status !== 204) {
    throw new Error(`account overview preflight returned HTTP ${response.status}; expected 204`)
  }
  inspectCredentialedCors(response, appOrigin, "account overview")
  if (response.headers.get("access-control-allow-methods") !== "GET, OPTIONS") {
    throw new Error("account overview preflight methods are not exact")
  }
  if (response.headers.get("access-control-allow-headers") !== "Authorization, X-Org-ID") {
    throw new Error("account overview preflight headers are not exact")
  }
  if (response.headers.get("access-control-max-age") !== "600") {
    throw new Error("account overview preflight max age is not exact")
  }
}

export async function inspectAnonymousAccountOverview(response: Response, appOrigin: string) {
  if (response.status !== 401) {
    throw new Error(`anonymous account overview returned HTTP ${response.status}; expected 401`)
  }
  inspectCredentialedCors(response, appOrigin, "account overview")
  const body = inspectJsonApiPayload(
    response.headers.get("content-type"),
    await response.text(),
    "anonymous account overview response",
  )
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    (body as { error?: unknown }).error !== "unauthorized" ||
    (body as { message?: unknown }).message !== "MongolGPT бүртгэлээр нэвтэрнэ үү."
  ) {
    throw new Error("anonymous account overview response is not fail-closed")
  }
}

function inspectCredentialedCors(response: Response, appOrigin: string, label: string) {
  if (response.headers.get("access-control-allow-origin") !== appOrigin) {
    throw new Error(`${label} CORS origin does not match the app`)
  }
  if (response.headers.get("access-control-allow-credentials") !== "true") {
    throw new Error(`${label} CORS credentials are not enabled`)
  }
  if (response.headers.get("cache-control")?.toLowerCase().includes("no-store") !== true) {
    throw new Error(`${label} response is cacheable`)
  }
  const vary = response.headers
    .get("vary")
    ?.split(",")
    .map((value) => value.trim().toLowerCase())
  if (!vary?.includes("origin")) {
    throw new Error(`${label} response does not vary by Origin`)
  }
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function expectedRuntimeVersion() {
  const packageJSON: unknown = await Bun.file(new URL("../packages/runtime/package.json", import.meta.url)).json()
  if (
    typeof packageJSON !== "object" ||
    packageJSON === null ||
    !("version" in packageJSON) ||
    typeof packageJSON.version !== "string" ||
    !packageJSON.version.trim()
  ) {
    throw new Error("runtime package version is missing")
  }
  return packageJSON.version.trim()
}

async function checkAgentRuntime(serverUrl: string, stage: string, version: string) {
  const healthUrl = new URL("/global/health", `${serverUrl}/`)
  const response = await fetch(healthUrl, {
    headers: { "User-Agent": "mongolgpt-deployment-smoke" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  })
  inspectResponseOrigin({
    requestUrl: healthUrl.toString(),
    responseUrl: response.url,
    status: response.status,
    location: response.headers.get("location"),
    label: "agent runtime health",
  })
  if (!response.ok) throw new Error(`agent runtime health HTTP ${response.status}: ${healthUrl}`)

  const body = inspectJsonApiPayload(
    response.headers.get("content-type"),
    await response.text(),
    `agent runtime health (${healthUrl})`,
  )
  inspectRuntimeHealth(body, { stage, version })
}

async function checkHostedSessionBoundary(serverUrl: string, appUrl: string) {
  const sessionUrl = new URL("/auth/session", `${serverUrl}/`)
  const appOrigin = new URL(appUrl).origin
  const response = await fetch(sessionUrl, {
    headers: {
      Accept: "application/json",
      Origin: appOrigin,
      "User-Agent": "mongolgpt-deployment-smoke",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  inspectResponseOrigin({
    requestUrl: sessionUrl.toString(),
    responseUrl: response.url,
    status: response.status,
    location: response.headers.get("location"),
    label: "hosted session",
  })
  if (response.status !== 401) {
    throw new Error(`anonymous hosted session returned HTTP ${response.status}; expected 401: ${sessionUrl}`)
  }
  if (response.headers.get("access-control-allow-origin") !== appOrigin) {
    throw new Error(`hosted session CORS origin does not match the app: ${sessionUrl}`)
  }
  if (response.headers.get("access-control-allow-credentials") !== "true") {
    throw new Error(`hosted session does not allow credentialed requests: ${sessionUrl}`)
  }
  if (!response.headers.get("cache-control")?.toLowerCase().includes("no-store")) {
    throw new Error(`hosted session response is cacheable: ${sessionUrl}`)
  }
  inspectAnonymousHostedSession(
    inspectJsonApiPayload(
      response.headers.get("content-type"),
      await response.text(),
      `anonymous hosted session (${sessionUrl})`,
    ),
  )

  const foreignOrigin = "https://invalid-origin.example"
  const rejected = await fetch(sessionUrl, {
    headers: {
      Accept: "application/json",
      Origin: foreignOrigin,
      "User-Agent": "mongolgpt-deployment-smoke",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  inspectResponseOrigin({
    requestUrl: sessionUrl.toString(),
    responseUrl: rejected.url,
    status: rejected.status,
    location: rejected.headers.get("location"),
    label: "foreign origin hosted session",
  })
  await inspectForeignOriginRuntimeRejection(rejected)
}

export async function inspectForeignOriginRuntimeRejection(response: Response) {
  if (response.status !== 403) {
    throw new Error(`foreign origin runtime rejection returned HTTP ${response.status}; expected 403`)
  }
  if (response.headers.has("access-control-allow-origin") || response.headers.has("access-control-allow-credentials")) {
    throw new Error("foreign origin runtime rejection exposed CORS access")
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    throw new Error("foreign origin runtime rejection allows content sniffing")
  }
  inspectNoStoreResponse(response, "foreign origin runtime rejection")
  const body = inspectJsonApiPayload(
    response.headers.get("content-type"),
    await response.text(),
    "foreign origin runtime rejection",
  )
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    (body as { error?: unknown }).error !== "MongolGPT веб апп-аас хүсэлт илгээнэ үү."
  ) {
    throw new Error("foreign origin runtime rejection is not fail-closed")
  }
}

export function inspectNoStoreResponse(response: Response, label: string) {
  const directives = response.headers
    .get("cache-control")
    ?.split(",")
    .map((value) => value.trim().toLowerCase())
  if (!directives?.includes("no-store")) throw new Error(`${label} is cacheable`)
}

async function checkAnonymousRuntimeApiBoundary(serverUrl: string, appUrl: string) {
  const appOrigin = new URL(appUrl).origin
  const checks: ReadonlyArray<{
    label: string
    path: string
    method: "GET" | "POST"
    body?: string
  }> = [
    { label: "project API", path: "/project", method: "GET" },
    { label: "provider API", path: "/provider", method: "GET" },
    {
      label: "session create API",
      path: "/session",
      method: "POST",
      body: JSON.stringify({ title: "MongolGPT anonymous deployment smoke" }),
    },
    {
      label: "Free Auto message API",
      path: "/session/mongolgpt-anonymous-smoke/message",
      method: "POST",
      body: JSON.stringify({
        model: { providerID: "mongolgpt", modelID: "free-auto" },
        parts: [{ type: "text", text: "MONGOLGPT_ANONYMOUS_SMOKE" }],
      }),
    },
  ]

  for (const check of checks) {
    const url = new URL(check.path, `${serverUrl}/`)
    const response = await fetch(url, {
      method: check.method,
      headers: {
        Accept: "application/json",
        Origin: appOrigin,
        "User-Agent": "mongolgpt-deployment-smoke",
        ...(check.body ? { "Content-Type": "application/json" } : {}),
      },
      body: check.body,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
    inspectResponseOrigin({
      requestUrl: url.toString(),
      responseUrl: response.url,
      status: response.status,
      location: response.headers.get("location"),
      label: `anonymous runtime ${check.label}`,
    })
    await inspectAnonymousRuntimeApiResponse(response, appOrigin, check.label)
  }
}

export async function inspectAnonymousRuntimeApiResponse(response: Response, appOrigin: string, label = "API") {
  if (response.status !== 401) {
    throw new Error(`anonymous runtime API returned HTTP ${response.status}; expected 401`)
  }
  if (response.headers.get("access-control-allow-origin") !== appOrigin) {
    throw new Error("anonymous runtime API CORS origin does not match the app")
  }
  if (response.headers.get("access-control-allow-credentials") !== "true") {
    throw new Error("anonymous runtime API does not allow credentialed requests")
  }
  if (!response.headers.get("cache-control")?.toLowerCase().includes("no-store")) {
    throw new Error("anonymous runtime API response is cacheable")
  }
  inspectAnonymousRuntimeApi(
    inspectJsonApiPayload(
      response.headers.get("content-type"),
      await response.text(),
      `anonymous runtime ${label} response`,
    ),
  )
}

async function checkAuthenticatedHostedFlow(input: {
  consoleUrl: string
  appUrl: string
  runtimeUrl: string
  authCookie: string
}) {
  const retries = positiveInteger(process.env.MONGOLGPT_SMOKE_RETRIES, 8)
  const delay = positiveInteger(process.env.MONGOLGPT_SMOKE_DELAY_MS, 10_000)
  let lastError: unknown

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await authenticatedHostedFlow(input)
      console.log("OK authenticated account, hosted runtime, and Free Auto")
      return
    } catch (error) {
      lastError = error
      console.warn(
        `WAIT authenticated hosted flow (${attempt}/${retries}): ${error instanceof Error ? error.message : String(error)}`,
      )
      if (attempt < retries) await Bun.sleep(delay)
    }
  }

  throw new Error(
    `authenticated hosted smoke check failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

async function authenticatedHostedFlow(input: {
  consoleUrl: string
  appUrl: string
  runtimeUrl: string
  authCookie: string
}) {
  const appOrigin = new URL(input.appUrl).origin
  const overviewUrl = new URL("/v1/account/overview", `${input.consoleUrl}/`)
  const overviewResponse = await authenticatedFetch(overviewUrl, appOrigin, {
    headers: { Cookie: input.authCookie },
  })
  const overview = inspectAuthenticatedAccountOverview(
    await authenticatedJson(overviewResponse, appOrigin, "authenticated account overview"),
  )

  const runtimeSession = await exchangeRuntimeSession({
    consoleUrl: input.consoleUrl,
    runtimeUrl: input.runtimeUrl,
    appOrigin,
    authCookie: input.authCookie,
    account: overview,
  })
  const sessionUrl = new URL("/auth/session", `${input.runtimeUrl}/`)
  const sessionResponse = await authenticatedFetch(sessionUrl, appOrigin, {
    headers: { Cookie: runtimeSession.cookie },
  })
  inspectAuthenticatedRuntimeSession(
    await authenticatedJson(sessionResponse, appOrigin, "authenticated runtime session"),
    { accountID: overview.accountID, maximumExpiresAt: runtimeSession.expiresAt },
  )

  const runtimeHeaders = {
    Cookie: runtimeSession.cookie,
    "x-mongolgpt-directory": "/workspace",
  }
  const projectUrl = new URL("/project", `${input.runtimeUrl}/`)
  const projectResponse = await authenticatedFetch(projectUrl, appOrigin, {
    headers: runtimeHeaders,
    timeout: 85_000,
  })
  inspectAuthenticatedRuntimeProjects(
    await authenticatedJson(projectResponse, appOrigin, "authenticated runtime project response"),
  )

  const providerUrl = new URL("/provider", `${input.runtimeUrl}/`)
  const providerResponse = await authenticatedFetch(providerUrl, appOrigin, { headers: runtimeHeaders })
  inspectAuthenticatedFreeAutoProvider(
    await authenticatedJson(providerResponse, appOrigin, "authenticated runtime provider response"),
  )

  const modelSession = await exchangeRuntimeSession({
    consoleUrl: input.consoleUrl,
    runtimeUrl: input.runtimeUrl,
    appOrigin,
    authCookie: input.authCookie,
    account: overview,
  })
  const modelHeaders = {
    Cookie: modelSession.cookie,
    "x-mongolgpt-directory": "/workspace",
  }
  const createUrl = new URL("/session", `${input.runtimeUrl}/`)
  const createResponse = await authenticatedFetch(createUrl, appOrigin, {
    method: "POST",
    headers: { ...modelHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "MongolGPT deploy smoke" }),
  })
  const created = inspectAuthenticatedRuntimeSessionCreate(
    await authenticatedJson(createResponse, appOrigin, "authenticated runtime session create response"),
  )

  const promptResult = await (async () => {
    const promptUrl = new URL(`/session/${encodeURIComponent(created.sessionID)}/message`, `${input.runtimeUrl}/`)
    const promptResponse = await authenticatedFetch(promptUrl, appOrigin, {
      method: "POST",
      headers: { ...modelHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "mongolgpt", modelID: "free-auto" },
        parts: [{ type: "text", text: "Зөвхөн MONGOLGPT_SMOKE_READY гэж хариул." }],
      }),
      timeout: 60_000,
    })
    inspectAuthenticatedFreeAutoResponse(
      await authenticatedJson(promptResponse, appOrigin, "authenticated Free Auto response"),
      created.sessionID,
    )
  })().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  )

  const deleteUrl = new URL(`/session/${encodeURIComponent(created.sessionID)}`, `${input.runtimeUrl}/`)
  const deleteResponse = await authenticatedFetch(deleteUrl, appOrigin, {
    method: "DELETE",
    headers: modelHeaders,
  })
  const deleted = await authenticatedJson(deleteResponse, appOrigin, "authenticated runtime session cleanup")
  if (deleted !== true) throw new Error("authenticated runtime session cleanup did not delete the smoke session")
  if (!promptResult.ok) throw promptResult.error
}

async function exchangeRuntimeSession(input: {
  consoleUrl: string
  runtimeUrl: string
  appOrigin: string
  authCookie: string
  account: { accountID: string; email: string }
}) {
  const tokenUrl = new URL("/auth/runtime-token", `${input.consoleUrl}/`)
  const tokenResponse = await authenticatedFetch(tokenUrl, input.appOrigin, {
    method: "POST",
    headers: { Cookie: input.authCookie },
  })
  const capability = inspectAuthenticatedRuntimeToken(
    await authenticatedJson(tokenResponse, input.appOrigin, "authenticated runtime token"),
    input.account,
  )
  const sessionUrl = new URL("/auth/session", `${input.runtimeUrl}/`)
  const exchangeResponse = await authenticatedFetch(sessionUrl, input.appOrigin, {
    method: "POST",
    headers: { Authorization: `Bearer ${capability.token}` },
  })
  inspectAuthenticatedRuntimeSession(
    await authenticatedJson(exchangeResponse, input.appOrigin, "authenticated runtime session exchange"),
    { accountID: input.account.accountID, maximumExpiresAt: capability.expiresAt },
  )
  return {
    cookie: inspectRuntimeSessionCookie(exchangeResponse.headers.get("set-cookie"), capability.token),
    expiresAt: capability.expiresAt,
  }
}

async function authenticatedFetch(
  url: URL,
  appOrigin: string,
  input: {
    method?: "GET" | "POST" | "DELETE"
    headers?: Record<string, string>
    body?: string
    timeout?: number
  } = {},
) {
  const response = await fetch(url, {
    method: input.method ?? "GET",
    body: input.body,
    headers: {
      Accept: "application/json",
      Origin: appOrigin,
      "User-Agent": "mongolgpt-deployment-smoke",
      ...input.headers,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(input.timeout ?? 15_000),
  })
  inspectResponseOrigin({
    requestUrl: url.toString(),
    responseUrl: response.url,
    status: response.status,
    location: response.headers.get("location"),
    label: "authenticated hosted request",
  })
  return response
}

async function authenticatedJson(response: Response, appOrigin: string, label: string) {
  if (response.status !== 200) throw new Error(`${label} returned HTTP ${response.status}; expected 200`)
  inspectCredentialedCors(response, appOrigin, label)
  return inspectJsonApiPayload(response.headers.get("content-type"), await response.text(), label)
}

async function checkStaticAssets(pageUrl: string, html: string, label: string) {
  const assets = inspectHtmlAssets(html, pageUrl, label)
  for (const asset of assets) {
    const response = await fetch(asset.url, {
      headers: { "User-Agent": "mongolgpt-deployment-smoke" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    })
    inspectResponseOrigin({
      requestUrl: asset.url,
      responseUrl: response.url,
      status: response.status,
      location: response.headers.get("location"),
      label: `${label} ${asset.kind}`,
    })
    if (!response.ok) throw new Error(`${label} ${asset.kind} HTTP ${response.status}: ${asset.url}`)
    inspectStaticAssetContentType(response.headers.get("content-type"), asset, `${label} ${asset.kind}`)
    const body = await response.text()
    if (/^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(body)) {
      throw new Error(`${label} ${asset.kind} returned an HTML/static shell`)
    }
  }
}
