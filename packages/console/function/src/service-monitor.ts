import {
  SERVICE_MONITOR_SERVICES,
  SERVICE_MONITOR_STATE_KEY,
  SERVICE_MONITOR_TTL_SECONDS,
  ServiceMonitorEvidenceSchema,
  type ServiceMonitorCheck,
} from "@mongolgpt/console-core/service-monitor.js"
import { Resource } from "@mongolgpt/console-resource"
import { z } from "zod"

const MAX_HEALTH_RESPONSE_BYTES = 16 * 1024
const HEALTH_TIMEOUT_MS = 4_000

const consoleHealthSchema = z.object({ status: z.literal("ok"), service: z.literal("console") }).strict()
const authHealthSchema = z.object({ status: z.literal("ok"), service: z.literal("auth") }).strict()
const runtimeHealthSchema = z
  .object({
    healthy: z.literal(true),
    service: z.literal("mongolgpt-runtime"),
    stage: z.string().trim().min(1).max(63),
    version: z.string().trim().min(1).max(128),
  })
  .strict()
const paymentHealthSchema = z
  .object({
    status: z.enum(["ok", "degraded", "disabled"]),
    service: z.literal("payments"),
    environment: z.enum(["disabled", "sandbox", "production"]),
    providers: z.object({ qpay: z.boolean(), bonum: z.boolean() }).strict(),
    catalog: z.boolean(),
    checkout: z.boolean(),
    cancellation: z.boolean(),
  })
  .strict()

type MonitorConfig = {
  stage: string
  stageDomain: string
}

type StateStore = {
  put(key: string, value: string, options: { expirationTtl: number }): Promise<unknown>
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type MonitorOptions = {
  fetcher?: Fetcher
  now?: () => number
  timer?: () => number
}

type Target = {
  service: (typeof SERVICE_MONITOR_SERVICES)[number]
  url: string
  accepts(value: unknown, stage: string): boolean
}

export async function runServiceMonitor(config: MonitorConfig, state: StateStore, options: MonitorOptions = {}) {
  const normalized = normalizeConfig(config)
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now
  const timer = options.timer ?? Date.now
  const checkedAt = now()
  const checks = await Promise.all(
    monitorTargets(normalized.stage, normalized.stageDomain).map((target) =>
      checkTarget(target, normalized.stage, fetcher, timer),
    ),
  )
  const evidence = ServiceMonitorEvidenceSchema.parse({
    version: 1,
    stage: normalized.stage,
    checkedAt,
    status: checks.every((check) => check.ok) ? "ok" : "degraded",
    checks,
  })
  await state.put(SERVICE_MONITOR_STATE_KEY, JSON.stringify(evidence), {
    expirationTtl: SERVICE_MONITOR_TTL_SECONDS,
  })
  return evidence
}

function monitorTargets(stage: string, stageDomain: string): Target[] {
  return [
    {
      service: "console",
      url: `https://${stageDomain}/api/health`,
      accepts: (value) => consoleHealthSchema.safeParse(value).success,
    },
    {
      service: "auth",
      url: `https://auth.${stageDomain}/health`,
      accepts: (value) => authHealthSchema.safeParse(value).success,
    },
    {
      service: "runtime",
      url: `https://runtime.${stageDomain}/global/health`,
      accepts: (value, expectedStage) => {
        const parsed = runtimeHealthSchema.safeParse(value)
        return parsed.success && parsed.data.stage === expectedStage
      },
    },
    {
      service: "payments",
      url: `https://pay.${stageDomain}/health`,
      accepts: (value) => {
        const parsed = paymentHealthSchema.safeParse(value)
        return parsed.success && parsed.data.status !== "degraded"
      },
    },
  ]
}

async function checkTarget(target: Target, stage: string, fetcher: Fetcher, timer: () => number) {
  const startedAt = timer()
  try {
    const response = await fetcher(target.url, {
      headers: { Accept: "application/json", "User-Agent": "mongolgpt-service-monitor" },
      redirect: "error",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) return failed(target.service, boundedLatency(startedAt, timer()), "http", response.status)
    if (!jsonResponse(response))
      return failed(target.service, boundedLatency(startedAt, timer()), "schema", response.status)
    const body = await readBoundedJson(response)
    const latencyMs = boundedLatency(startedAt, timer())
    if (!target.accepts(body, stage)) return failed(target.service, latencyMs, "schema", response.status)
    return { service: target.service, ok: true, httpStatus: response.status, latencyMs } satisfies ServiceMonitorCheck
  } catch (error) {
    const failure = abortError(error) ? "timeout" : "network"
    return failed(target.service, boundedLatency(startedAt, timer()), failure)
  }
}

async function readBoundedJson(response: Response) {
  if (!response.body) return undefined
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_HEALTH_RESPONSE_BYTES) return undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let body = ""
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_HEALTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      body += decoder.decode(part.value, { stream: true })
    }
    body += decoder.decode()
    return JSON.parse(body)
  } catch {
    return undefined
  } finally {
    reader.releaseLock()
  }
}

function normalizeConfig(config: MonitorConfig) {
  const stage = config.stage.trim().toLowerCase()
  const stageDomain = config.stageDomain.trim().toLowerCase().replace(/\.$/, "")
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(stage)) throw new TypeError("Monitor stage буруу байна.")
  if (stageDomain.length > 253 || !stageDomain.includes(".")) throw new TypeError("Monitor domain буруу байна.")
  if (
    stageDomain === "localhost" ||
    stageDomain.endsWith(".localhost") ||
    stageDomain.endsWith(".example") ||
    stageDomain.endsWith(".duckdns.org") ||
    stageDomain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new TypeError("Monitor domain буруу байна.")
  }
  if (stage !== "production" && !stageDomain.startsWith(`${stage}.`)) {
    throw new TypeError("Monitor stage болон domain зөрж байна.")
  }
  return { stage, stageDomain }
}

function failed(
  service: ServiceMonitorCheck["service"],
  latencyMs: number,
  failure: NonNullable<ServiceMonitorCheck["failure"]>,
  httpStatus?: number,
): ServiceMonitorCheck {
  return { service, ok: false, ...(httpStatus ? { httpStatus } : {}), latencyMs, failure }
}

function boundedLatency(startedAt: number, finishedAt: number) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return 0
  return Math.min(60_000, Math.max(0, Math.round(finishedAt - startedAt)))
}

function abortError(error: unknown) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
}

function jsonResponse(response: Response) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
}

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated SST types gain this binding after deploy
const resources = Resource as unknown as { ServiceMonitorState: StateStore }

export default {
  async scheduled() {
    const evidence = await runServiceMonitor(
      {
        stage: process.env.MONGOLGPT_STAGE ?? "",
        stageDomain: process.env.MONGOLGPT_STAGE_DOMAIN ?? "",
      },
      resources.ServiceMonitorState,
    )
    console.log("Үйлчилгээний хяналтын шалгалт дууслаа", {
      checkedAt: evidence.checkedAt,
      status: evidence.status,
      failedServices: evidence.checks.filter((check) => !check.ok).map((check) => check.service),
    })
  },
}
