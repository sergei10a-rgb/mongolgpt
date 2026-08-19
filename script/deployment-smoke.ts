import { deploymentEndpoints, preflightDeployment } from "@mongolgpt/script/deployment"
import type { DeploymentPreflightResult } from "@mongolgpt/script/deployment"
import {
  inspectAdminProtection,
  inspectAuthHealth,
  inspectConsoleHealth,
  inspectDeploymentEndpointConfiguration,
  inspectAnonymousHostedSession,
  inspectAnonymousRuntimeApi,
  inspectAppHtml,
  inspectHtmlAssets,
  inspectHostedAppRuntime,
  inspectHtmlContentType,
  inspectJsonApiPayload,
  inspectPaymentHealth,
  inspectResponseOrigin,
  inspectStaticAssetContentType,
  inspectRuntimeHealth,
} from "@mongolgpt/script/deployment-smoke-contract"

if (import.meta.main) await runSmoke()

async function runSmoke() {
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

  console.log("Cloudflare deployment smoke check passed.")
}

async function check(
  name: string,
  url: string,
  health: "console" | "auth" | "runtime" | "payment" | "admin" | undefined,
  result: DeploymentPreflightResult,
  appUrl: string,
  runtimeVersion: string,
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
        await checkHostedAuthorize(url, new URL(authHealthUrl).origin)
      } else if (name === "docs") {
        inspectHtmlContentType(response.headers.get("content-type"), "docs response")
        const html = await response.text()
        await checkStaticAssets(url, html, "docs response")
      } else if (name === "app") {
        inspectHtmlContentType(response.headers.get("content-type"), "app response")
        const html = await response.text()
        const contract = inspectAppDeployment(html, url, result)
        await checkStaticAssets(url, html, "app response")
        if (contract.mode === "hosted") {
          const runtimeHealthUrl = deploymentEndpoints(result).runtimeHealth
          if (!runtimeHealthUrl) throw new Error("hosted app runtime endpoint is missing")
          inspectHostedAppRuntime(contract, { channel: appChannel(result), runtimeHealthUrl })
          await checkAgentRuntime(contract.serverUrl, result.stage, runtimeVersion)
          await checkHostedSessionBoundary(contract.serverUrl, url)
          await checkAnonymousRuntimeApiBoundary(contract.serverUrl, url)
        }
        await checkDirectAppRoute(url, result)
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
  return contract
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

async function checkHostedAuthorize(consoleUrl: string, authOrigin: string) {
  const requestUrl = new URL("/auth/authorize?continue=/auth/app", `${consoleUrl}/`).toString()
  const response = await fetch(requestUrl, {
    headers: { "User-Agent": "mongolgpt-deployment-smoke" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  inspectHostedAuthorizeRedirect({
    requestUrl,
    responseUrl: response.url,
    status: response.status,
    location: response.headers.get("location"),
    authOrigin,
  })
  await response.body?.cancel()
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
  if (rejected.status !== 403) {
    throw new Error(`foreign hosted session origin returned HTTP ${rejected.status}; expected 403: ${sessionUrl}`)
  }
  const body = inspectJsonApiPayload(
    rejected.headers.get("content-type"),
    await rejected.text(),
    `foreign origin rejection (${sessionUrl})`,
  )
  if (typeof body !== "object" || body === null || typeof (body as { error?: unknown }).error !== "string") {
    throw new Error(`foreign origin rejection body is invalid: ${sessionUrl}`)
  }
}

async function checkAnonymousRuntimeApiBoundary(serverUrl: string, appUrl: string) {
  const projectUrl = new URL("/project", `${serverUrl}/`)
  const appOrigin = new URL(appUrl).origin
  const response = await fetch(projectUrl, {
    headers: {
      Accept: "application/json",
      Origin: appOrigin,
      "User-Agent": "mongolgpt-deployment-smoke",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  inspectResponseOrigin({
    requestUrl: projectUrl.toString(),
    responseUrl: response.url,
    status: response.status,
    location: response.headers.get("location"),
    label: "anonymous runtime project API",
  })
  await inspectAnonymousRuntimeApiResponse(response, appOrigin)
}

export async function inspectAnonymousRuntimeApiResponse(response: Response, appOrigin: string) {
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
      "anonymous runtime project API response",
    ),
  )
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
