import { deploymentEndpoints, preflightDeployment } from "@mongolgpt/script/deployment"

const result = preflightDeployment({
  stage: process.argv[2] ?? process.env.SST_STAGE ?? "dev",
  env: process.env,
  requireCloudflareCredentials: false,
})
const endpoints = deploymentEndpoints(result)
const healthUrls = new Set([endpoints.consoleHealth, endpoints.authHealth].filter((url): url is string => Boolean(url)))

for (const [name, url] of Object.entries(endpoints)) {
  await check(name, url, healthUrls.has(url))
}

console.log("Cloudflare deployment smoke check passed.")

async function check(name: string, url: string, health: boolean) {
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
        const body: unknown = await response.json()
        if (!isHealthyResponse(body)) throw new Error("health response status is not ok")
      } else if (name === "docs") {
        const html = await response.text()
        await checkStylesheet(url, html)
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
