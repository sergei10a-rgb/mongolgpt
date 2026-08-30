import { resolveHostedServiceUrls, type HostedServiceUrls } from "@mongolgpt/account-contract/service-urls"
import {
  PaymentHealthSchema,
  SERVICE_MONITOR_ALERT_REMINDER_MS,
  SERVICE_MONITOR_ALERT_STATE_MAX_AGE_MS,
  SERVICE_MONITOR_ALERT_STATE_KEY,
  SERVICE_MONITOR_ALERT_STATE_TTL_SECONDS,
  SERVICE_MONITOR_SERVICES,
  SERVICE_MONITOR_STATE_KEY,
  SERVICE_MONITOR_TTL_SECONDS,
  ServiceMonitorAlertStateSchema,
  ServiceMonitorEvidenceSchema,
  type ServiceMonitorAlertState,
  type ServiceMonitorCheck,
  type ServiceMonitorEvidence,
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
type MonitorConfig = {
  stage: string
  stageDomain: string
}

type StateStore = {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options: { expirationTtl: number }): Promise<unknown>
}

type EvidenceStore = Pick<StateStore, "put">

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type MonitorOptions = {
  fetcher?: Fetcher
  now?: () => number
  timer?: () => number
}

type EmailMessage = {
  from: string
  subject: string
  text: string
  to?: undefined
}

type EmailBinding = {
  send(message: EmailMessage): Promise<unknown>
}

type AlertKind = "opened" | "changed" | "reminder" | "recovered" | "none"

type AlertPlan = {
  kind: AlertKind
  state: ServiceMonitorAlertState
  notify: boolean
  persist: boolean
}

type Target = {
  service: (typeof SERVICE_MONITOR_SERVICES)[number]
  url: string
  accepts(value: unknown, stage: string): boolean
}

export async function runServiceMonitor(config: MonitorConfig, state: EvidenceStore, options: MonitorOptions = {}) {
  const normalized = normalizeConfig(config)
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now
  const timer = options.timer ?? Date.now
  const checkedAt = now()
  const checks = await Promise.all(
    monitorTargets(normalized.stage, normalized.urls).map((target) =>
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

export async function runServiceMonitorCycle(
  config: MonitorConfig & { alertFrom: string },
  state: StateStore,
  email: EmailBinding,
  options: MonitorOptions = {},
) {
  const now = options.now ?? Date.now
  const previous = await readAlertState(state, config.stage, now())
  const evidence = await runServiceMonitor(config, state, options)
  const plan = planServiceMonitorAlert(previous, evidence, now())
  if (plan.persist) {
    await state.put(SERVICE_MONITOR_ALERT_STATE_KEY, JSON.stringify(plan.state), {
      expirationTtl: SERVICE_MONITOR_ALERT_STATE_TTL_SECONDS,
    })
  }
  if (plan.notify && plan.kind !== "none") await sendServiceMonitorAlert(email, config.alertFrom, plan.kind, evidence)
  return { evidence, alert: plan.kind }
}

export function planServiceMonitorAlert(
  previous: ServiceMonitorAlertState | undefined,
  evidence: ServiceMonitorEvidence,
  now: number,
): AlertPlan {
  const current = alertState(evidence, now)
  if (!previous || previous.stage !== evidence.stage) {
    return {
      kind: evidence.status === "degraded" ? "opened" : "none",
      state: current,
      notify: evidence.status === "degraded",
      persist: true,
    }
  }
  if (evidence.status === "ok") {
    if (previous.status === "degraded") {
      return { kind: "recovered", state: current, notify: true, persist: true }
    }
    return { kind: "none", state: previous, notify: false, persist: false }
  }
  if (previous.status === "ok") {
    return { kind: "opened", state: current, notify: true, persist: true }
  }
  if (previous.fingerprint !== current.fingerprint) {
    return { kind: "changed", state: current, notify: true, persist: true }
  }
  if (now - previous.recordedAt >= SERVICE_MONITOR_ALERT_REMINDER_MS) {
    return { kind: "reminder", state: current, notify: true, persist: true }
  }
  return { kind: "none", state: previous, notify: false, persist: false }
}

function monitorTargets(stage: string, urls: HostedServiceUrls): Target[] {
  return [
    {
      service: "console",
      url: `${urls.console}/api/health`,
      accepts: (value) => consoleHealthSchema.safeParse(value).success,
    },
    {
      service: "auth",
      url: `${urls.auth}/health`,
      accepts: (value) => authHealthSchema.safeParse(value).success,
    },
    {
      service: "runtime",
      url: `${urls.runtime}/global/health`,
      accepts: (value, expectedStage) => {
        const parsed = runtimeHealthSchema.safeParse(value)
        return parsed.success && parsed.data.stage === expectedStage
      },
    },
    {
      service: "payments",
      url: `${urls.payment}/health`,
      accepts: (value, expectedStage) => {
        const parsed = PaymentHealthSchema.safeParse(value)
        if (!parsed.success) return false
        if (expectedStage === "production") return parsed.data.status === "ok"
        return parsed.data.status !== "degraded"
      },
    },
  ]
}

async function readAlertState(state: StateStore, stage: string, now: number) {
  const raw = await state.get(SERVICE_MONITOR_ALERT_STATE_KEY)
  if (!raw || raw.length > 4_096) return undefined
  try {
    const parsed = ServiceMonitorAlertStateSchema.safeParse(JSON.parse(raw))
    if (!parsed.success || parsed.data.stage !== stage.trim().toLowerCase()) return undefined
    if (parsed.data.recordedAt > now + 2 * 60 * 1_000) return undefined
    if (now - parsed.data.recordedAt > SERVICE_MONITOR_ALERT_STATE_MAX_AGE_MS) return undefined
    return parsed.data
  } catch {
    return undefined
  }
}

function alertState(evidence: ServiceMonitorEvidence, now: number): ServiceMonitorAlertState {
  return ServiceMonitorAlertStateSchema.parse({
    version: 1,
    stage: evidence.stage,
    status: evidence.status,
    fingerprint: alertFingerprint(evidence),
    recordedAt: now,
  })
}

function alertFingerprint(evidence: ServiceMonitorEvidence) {
  if (evidence.status === "ok") return "ok"
  return evidence.checks
    .filter((check) => !check.ok)
    .map((check) => `${check.service}:${check.failure}:${check.httpStatus ?? 0}`)
    .join(",")
}

async function sendServiceMonitorAlert(
  email: EmailBinding,
  from: string,
  kind: Exclude<AlertKind, "none">,
  evidence: ServiceMonitorEvidence,
) {
  const failed = evidence.checks.filter((check) => !check.ok)
  const stage = evidence.stage.toUpperCase()
  const recovered = kind === "recovered"
  const subject = recovered
    ? `[MongolGPT][${stage}] Үйлчилгээнүүд хэвийн боллоо`
    : `[MongolGPT][${stage}] ${alertKindLabel(kind)}: ${failed.map((check) => check.service).join(", ")}`
  const details = recovered
    ? evidence.checks.map((check) => `- ${check.service}: хэвийн (${check.latencyMs} мс)`)
    : failed.map(
        (check) =>
          `- ${check.service}: ${check.failure ?? "unknown"}${check.httpStatus ? `, HTTP ${check.httpStatus}` : ""}, ${check.latencyMs} мс`,
      )
  await email.send({
    to: undefined,
    from,
    subject,
    text: [
      recovered
        ? "MongolGPT-ийн хяналтын бүх үйлчилгээ хэвийн боллоо."
        : "MongolGPT-ийн үйлчилгээний хяналт доголдол илрүүллээ.",
      `Орчин: ${evidence.stage}`,
      `Шалгасан цаг: ${new Date(evidence.checkedAt).toISOString()}`,
      "",
      ...details,
      "",
      "Админ самбарын Системийн бэлэн байдал хэсгээс дэлгэрэнгүй төлөвийг шалгана уу.",
    ].join("\n"),
  })
}

function alertKindLabel(kind: Exclude<AlertKind, "none" | "recovered">) {
  if (kind === "changed") return "Доголдлын төлөв өөрчлөгдлөө"
  if (kind === "reminder") return "Доголдол үргэлжилж байна"
  return "Үйлчилгээ доголдлоо"
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
  const rootDomain = stage === "production" ? stageDomain : stageDomain.slice(stage.length + 1)
  try {
    const urls = resolveHostedServiceUrls(rootDomain, stage)
    if (urls.stageDomain !== stageDomain) throw new Error("stage domain mismatch")
    return { stage, stageDomain, urls }
  } catch {
    throw new TypeError("Monitor stage болон domain зөрж байна.")
  }
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
  async scheduled(_controller: unknown, env: { ServiceMonitorAlertEmail?: EmailBinding }) {
    const config = {
      stage: process.env.MONGOLGPT_STAGE ?? "",
      stageDomain: process.env.MONGOLGPT_STAGE_DOMAIN ?? "",
    }
    const alertsEnabled = process.env.MONGOLGPT_MONITOR_ALERTS_ENABLED === "true"
    const result = alertsEnabled
      ? await runServiceMonitorCycle(
          { ...config, alertFrom: process.env.MONGOLGPT_MONITOR_ALERT_FROM ?? "" },
          resources.ServiceMonitorState,
          requiredEmailBinding(env.ServiceMonitorAlertEmail),
        )
      : { evidence: await runServiceMonitor(config, resources.ServiceMonitorState), alert: "none" as const }
    const evidence = result.evidence
    console.log("Үйлчилгээний хяналтын шалгалт дууслаа", {
      checkedAt: evidence.checkedAt,
      status: evidence.status,
      alert: result.alert,
      failedServices: evidence.checks.filter((check) => !check.ok).map((check) => check.service),
    })
  },
}

function requiredEmailBinding(binding: EmailBinding | undefined) {
  if (!binding) throw new Error("Үйлчилгээний хяналтын Cloudflare Email binding холбогдоогүй байна.")
  const from = process.env.MONGOLGPT_MONITOR_ALERT_FROM?.trim() ?? ""
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    throw new Error("Үйлчилгээний хяналтын илгээгч имэйл тохируулагдаагүй байна.")
  }
  return binding
}
