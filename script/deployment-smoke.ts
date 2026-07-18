import { deploymentEndpoints, preflightDeployment } from "@mongolgpt/script/deployment"
import { inspectAppHtml } from "@mongolgpt/script/deployment-smoke-contract"

const result = preflightDeployment({
  stage: process.argv[2] ?? process.env.SST_STAGE ?? "dev",
  env: process.env,
  requireCloudflareCredentials: false,
})
const endpoints = deploymentEndpoints(result)
const healthContracts = new Map(
  [
    [endpoints.consoleHealth, "status"],
    [endpoints.authHealth, "status"],
    [endpoints.runtimeHealth, "runtime"],
  ].filter((entry): entry is [string, "status" | "runtime"] => Boolean(entry[0])),
)

for (const [name, url] of Object.entries(endpoints)) {
  await check(name, url, healthContracts.get(url))
}

console.log("Cloudflare deployment smoke check passed.")

async function check(name: string, url: string, health?: "status" | "runtime") {
  const retries = positiveInteger(process.env.MONGOLGPT_SMOKE_RETRIES, 8)
  const delay = positiveInteger(process.env.MONGOLGPT_SMOKE_DELAY_MS, 10_000)
  let lastError: unknown

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "mongolgpt-deployment-smoke" },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (health) {
        const contentType = response.headers.get("content-type") ?? ""
        if (!contentType.includes("application/json")) {
          throw new Error(`health response is not JSON: ${contentType || "missing content-type"}`)
        }
        const body: unknown = await response.json()
        if (health === "status" && !isHealthyResponse(body)) throw new Error("health response status is not ok")
        if (health === "runtime" && !isRuntimeHealthyResponse(body, result.stage)) {
          throw new Error("runtime health response is invalid")
        }
      } else if (name === "docs") {
        const html = await response.text()
        await checkStylesheet(url, html)
      } else if (name === "app") {
        const html = await response.text()
        const contract = inspectAppHtml(html, url)
        await checkAppModule(url, html)
        const expectedChannel = result.stage === "production" ? "prod" : result.stage === "dev" ? "dev" : "beta"
        if (contract.channel !== expectedChannel) {
          throw new Error(`app channel is ${contract.channel}; expected ${expectedChannel}`)
        }
        const expectedMode = result.hostedServices ? "hosted" : "local-bridge"
        if (contract.mode !== expectedMode) throw new Error(`app runtime mode is ${contract.mode}; expected ${expectedMode}`)
        if (contract.mode === "hosted") {
          const expectedRuntime = endpoints.runtimeHealth
            ? new URL(endpoints.runtimeHealth).origin
            : undefined
          if (!expectedRuntime || new URL(contract.serverUrl).origin !== expectedRuntime) {
            throw new Error(`app runtime origin is ${new URL(contract.serverUrl).origin}; expected ${expectedRuntime}`)
          }
          await checkAgentRuntime(contract.serverUrl)
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

  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    throw new Error(`agent runtime health is not JSON: ${contentType || "missing content-type"} (${healthUrl})`)
  }
  const body: unknown = await response.json()
  if (
    typeof body !== "object" ||
    body === null ||
    !("healthy" in body) ||
    (body as { healthy?: unknown }).healthy !== true
  ) {
    throw new Error(`agent runtime health response is invalid: ${healthUrl}`)
  }
}
