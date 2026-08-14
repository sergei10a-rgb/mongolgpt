import { deploymentEndpoints, preflightDeployment } from "@mongolgpt/script/deployment"
import type { DeploymentPreflightResult } from "@mongolgpt/script/deployment"
import {
  inspectAdminProtection,
  inspectAuthHealth,
  inspectConsoleHealth,
  inspectAnonymousHostedSession,
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
      } else if (name === "docs") {
        inspectHtmlContentType(response.headers.get("content-type"), "docs response")
        const html = await response.text()
        await checkStaticAssets(url, html, "docs response")
      } else if (name === "app") {
        inspectHtmlContentType(response.headers.get("content-type"), "app response")
        const html = await response.text()
        const contract = inspectAppHtml(html, url)
        await checkStaticAssets(url, html, "app response")
        const expectedChannel = result.stage === "production" ? "prod" : result.stage === "dev" ? "dev" : "beta"
        if (contract.channel !== expectedChannel) {
          throw new Error(`app channel is ${contract.channel}; expected ${expectedChannel}`)
        }
        const expectedMode = result.hostedServices ? "hosted" : "local-bridge"
        if (contract.mode !== expectedMode)
          throw new Error(`app runtime mode is ${contract.mode}; expected ${expectedMode}`)
        if (contract.mode === "hosted") {
          const runtimeHealthUrl = deploymentEndpoints(result).runtimeHealth
          if (!runtimeHealthUrl) throw new Error("hosted app runtime endpoint is missing")
          inspectHostedAppRuntime(contract, { channel: expectedChannel, runtimeHealthUrl })
          await checkAgentRuntime(contract.serverUrl, result.stage, runtimeVersion)
          await checkHostedSessionBoundary(contract.serverUrl, url)
        }
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
  inspectRuntimeTokenCors(response, appOrigin)
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
  inspectRuntimeTokenCors(response, appOrigin)
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

function inspectRuntimeTokenCors(response: Response, appOrigin: string) {
  if (response.headers.get("access-control-allow-origin") !== appOrigin) {
    throw new Error("runtime token CORS origin does not match the app")
  }
  if (response.headers.get("access-control-allow-credentials") !== "true") {
    throw new Error("runtime token CORS credentials are not enabled")
  }
  if (response.headers.get("cache-control")?.toLowerCase().includes("no-store") !== true) {
    throw new Error("runtime token response is cacheable")
  }
  const vary = response.headers
    .get("vary")
    ?.split(",")
    .map((value) => value.trim().toLowerCase())
  if (!vary?.includes("origin")) {
    throw new Error("runtime token response does not vary by Origin")
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
