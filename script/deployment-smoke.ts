import { deploymentEndpoints, preflightDeployment } from "@mongolgpt/script/deployment"
import type { DeploymentPreflightResult } from "@mongolgpt/script/deployment"
import {
  inspectAnonymousHostedSession,
  inspectAppHtml,
  inspectHostedAppRuntime,
  inspectHtmlContentType,
  inspectJsonApiPayload,
  inspectPaymentHealth,
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
  const healthContracts = new Map(
    [
      [endpoints.consoleHealth, "status"],
      [endpoints.authHealth, "status"],
      [endpoints.runtimeHealth, "runtime"],
      [endpoints.paymentHealth, "payment"],
      [endpoints.admin, "admin"],
    ].filter((entry): entry is [string, "status" | "runtime" | "payment" | "admin"] => Boolean(entry[0])),
  )

  for (const [name, url] of Object.entries(endpoints)) {
    await check(name, url, healthContracts.get(url), result, endpoints.app)
  }

  console.log("Cloudflare deployment smoke check passed.")
}

async function check(
  name: string,
  url: string,
  health: "status" | "runtime" | "payment" | "admin" | undefined,
  result: DeploymentPreflightResult,
  appUrl: string,
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
        if (![302, 401, 403].includes(response.status)) {
          throw new Error(`admin endpoint is not protected: HTTP ${response.status}`)
        }
      } else if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (health && health !== "admin") {
        const body = inspectJsonApiPayload(
          response.headers.get("content-type"),
          await response.text(),
          `${health} health response`,
        )
        if (health === "status" && !isHealthyResponse(body)) throw new Error("health response status is not ok")
        if (health === "runtime" && !isRuntimeHealthyResponse(body, result.stage)) {
          throw new Error("runtime health response is invalid")
        }
        if (health === "payment") inspectPaymentHealth(body, result.paymentEnvironment)
      } else if (name === "console") {
        await checkHostedRuntimeToken(url, appUrl)
      } else if (name === "docs") {
        inspectHtmlContentType(response.headers.get("content-type"), "docs response")
        const html = await response.text()
        await checkStylesheet(url, html)
      } else if (name === "app") {
        inspectHtmlContentType(response.headers.get("content-type"), "app response")
        const html = await response.text()
        const contract = inspectAppHtml(html, url)
        await checkAppModule(url, html)
        const expectedChannel = result.stage === "production" ? "prod" : result.stage === "dev" ? "dev" : "beta"
        if (contract.channel !== expectedChannel) {
          throw new Error(`app channel is ${contract.channel}; expected ${expectedChannel}`)
        }
        const expectedMode = result.hostedServices ? "hosted" : "local-bridge"
        if (contract.mode !== expectedMode)
          throw new Error(`app runtime mode is ${contract.mode}; expected ${expectedMode}`)
        if (contract.mode === "hosted") {
          const runtimeHealthUrl = deploymentEndpoints(result).runtimeHealth
          const expectedRuntime = runtimeHealthUrl ? new URL(runtimeHealthUrl).origin : undefined
          if (!runtimeHealthUrl || !expectedRuntime) throw new Error("hosted app runtime endpoint is missing")
          inspectHostedAppRuntime(contract, { channel: expectedChannel, runtimeHealthUrl })
          await checkAgentRuntime(contract.serverUrl)
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

function isHealthyResponse(value: unknown): value is { status: "ok" } {
  return typeof value === "object" && value !== null && "status" in value && value.status === "ok"
}

function isRuntimeHealthyResponse(value: unknown, stage: string) {
  if (typeof value !== "object" || value === null) return false
  const body = value as { healthy?: unknown; service?: unknown; stage?: unknown }
  return body.healthy === true && body.service === "mongolgpt-runtime" && body.stage === stage
}

async function checkStylesheet(pageUrl: string, html: string) {
  const match = html.match(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/i)
  if (!match?.[1]) throw new Error("docs stylesheet was not found")

  const stylesheetUrl = new URL(match[1], pageUrl)
  const response = await fetch(stylesheetUrl, {
    headers: { "User-Agent": "mongolgpt-deployment-smoke" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`docs stylesheet HTTP ${response.status}: ${stylesheetUrl}`)

  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("text/css")) {
    throw new Error(`docs stylesheet is not CSS: ${contentType || "missing content-type"} (${stylesheetUrl})`)
  }
  await response.body?.cancel()
}

async function checkAppModule(pageUrl: string, html: string) {
  const match = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i)
  if (!match?.[1]) throw new Error("app module script was not found")

  const moduleUrl = new URL(match[1], pageUrl)
  const response = await fetch(moduleUrl, {
    headers: { "User-Agent": "mongolgpt-deployment-smoke" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`app module HTTP ${response.status}: ${moduleUrl}`)

  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("javascript")) {
    throw new Error(`app module is not JavaScript: ${contentType || "missing content-type"} (${moduleUrl})`)
  }
  await response.body?.cancel()
}

async function checkAgentRuntime(serverUrl: string) {
  const healthUrl = new URL("/global/health", `${serverUrl}/`)
  const response = await fetch(healthUrl, {
    headers: { "User-Agent": "mongolgpt-deployment-smoke" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`agent runtime health HTTP ${response.status}: ${healthUrl}`)

  const body = inspectJsonApiPayload(
    response.headers.get("content-type"),
    await response.text(),
    `agent runtime health (${healthUrl})`,
  )
  if (
    typeof body !== "object" ||
    body === null ||
    !("healthy" in body) ||
    (body as { healthy?: unknown }).healthy !== true
  ) {
    throw new Error(`agent runtime health response is invalid: ${healthUrl}`)
  }
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
