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

console.log("Cloudflare deployment smoke check амжилттай.")

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
        if (!isHealthyResponse(body)) throw new Error("health response status нь ok биш")
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

  throw new Error(
    `${name} smoke check амжилтгүй: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isHealthyResponse(value: unknown): value is { status: "ok" } {
  return typeof value === "object" && value !== null && "status" in value && value.status === "ok"
}
