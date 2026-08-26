import { Database } from "@mongolgpt/console-core/drizzle/index.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import {
  SERVICE_MONITOR_MAX_AGE_MS,
  SERVICE_MONITOR_STATE_KEY,
  ServiceMonitorEvidenceSchema,
} from "@mongolgpt/console-core/service-monitor.js"
import {
  USAGE_QUEUE_READINESS_KEY,
  USAGE_QUEUE_READINESS_MAX_AGE_MS,
  UsageQueueHeartbeatEvidenceSchema,
} from "@mongolgpt/console-core/usage-queue-readiness.js"
import { Resource } from "@mongolgpt/console-resource"
import { z } from "zod"

export type SystemReadinessState = "healthy" | "configured" | "degraded" | "disabled" | "missing"

export interface SystemReadinessCheck {
  id: "database" | "runtime" | "oauth" | "quota" | "usage-queue" | "payments" | "monitoring" | "backup"
  label: string
  state: SystemReadinessState
  summary: string
}

export interface SystemReadinessReport {
  status: "ok" | "degraded"
  stage: string
  checks: SystemReadinessCheck[]
  checkedAt: string
}

type WorkerBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

type BackupBucket = {
  list(options?: {
    prefix?: string
    limit?: number
    include?: ("httpMetadata" | "customMetadata")[]
  }): Promise<{ objects: unknown[] }>
}

export interface SystemReadinessDependencies {
  stage: string
  runtimeURL: string
  backupsEnabled: boolean
  monitoringEnabled: boolean
  database(): Promise<void>
  auth(): Promise<Response>
  quota(): Promise<Response>
  payments(): Promise<Response>
  runtime(): Promise<Response>
  queueHeartbeat(): Promise<string | null>
  monitorEvidence(): Promise<string | null>
  backups(): Promise<{ objects: unknown[] }>
  now(): Date
}

type ProbeResult<T> = { ok: true; value: T } | { ok: false }

const authHealthSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("auth"),
  })
  .strict()

const quotaHealthSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("quota"),
    storage: z.literal("durable-objects"),
    queue: z.literal("cloudflare-queues"),
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

const runtimeHealthSchema = z
  .object({
    healthy: z.literal(true),
    version: z.string().trim().min(1),
  })
  .passthrough()

const backupObjectSchema = z
  .object({
    key: z.string().trim().min(1).max(1024),
    size: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024 * 1024),
    uploaded: z.coerce.date(),
    customMetadata: z
      .object({
        createdAt: z.string().datetime(),
        source: z.literal("cloudflare-d1-export"),
        stage: z.string().trim().min(1).max(63),
      })
      .strict(),
  })
  .passthrough()

const FUTURE_CLOCK_SKEW_MS = 2 * 60 * 1_000
const D1_BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1_000
const D1_BACKUP_MAX_UPLOAD_DELAY_MS = 24 * 60 * 60 * 1_000

export async function getSystemReadiness() {
  const resources = {
    AuthApi: Resource.AuthApi,
    D1Backups: Resource.D1Backups,
    PaymentService: Resource.PaymentService,
    QuotaService: Resource.QuotaService,
    ServiceMonitorState: Resource.ServiceMonitorState,
    UsageQueueReadiness: Resource.UsageQueueReadiness,
  } satisfies {
    AuthApi: WorkerBinding
    D1Backups: BackupBucket
    PaymentService: WorkerBinding
    QuotaService: WorkerBinding
    ServiceMonitorState: { get(key: string): Promise<string | null> }
    UsageQueueReadiness: { get(key: string): Promise<string | null> }
  }
  const stage = process.env.MONGOLGPT_STAGE?.trim() || "тодорхойгүй"
  const runtimeURL = process.env.MONGOLGPT_RUNTIME_URL?.trim() || ""
  const backupsEnabled = process.env.MONGOLGPT_D1_BACKUPS_ENABLED === "true"
  const monitoringEnabled = process.env.MONGOLGPT_MONITORING_ENABLED === "true"
  const timeout = () => AbortSignal.timeout(4_000)

  return collectSystemReadiness({
    stage,
    runtimeURL,
    backupsEnabled,
    monitoringEnabled,
    database: () =>
      Database.use(async (tx) => {
        await tx.select({ id: AccountTable.id }).from(AccountTable).limit(1)
      }),
    auth: () =>
      resources.AuthApi.fetch("https://auth.internal/health", {
        headers: { Accept: "application/json" },
        signal: timeout(),
      }),
    quota: () =>
      resources.QuotaService.fetch("https://quota.internal/health", {
        headers: { Accept: "application/json" },
        signal: timeout(),
      }),
    payments: () =>
      resources.PaymentService.fetch("https://payments.internal/health", {
        headers: { Accept: "application/json" },
        signal: timeout(),
      }),
    runtime: () =>
      fetch(new URL("/global/health", `${runtimeURL}/`), {
        headers: { Accept: "application/json", "User-Agent": "mongolgpt-admin-readiness" },
        redirect: "error",
        signal: timeout(),
      }),
    queueHeartbeat: () => resources.UsageQueueReadiness.get(USAGE_QUEUE_READINESS_KEY),
    monitorEvidence: () => resources.ServiceMonitorState.get(SERVICE_MONITOR_STATE_KEY),
    backups: () =>
      resources.D1Backups.list({
        prefix: `d1/${stage.toLowerCase()}/`,
        limit: 1_000,
        include: ["customMetadata"],
      }),
    now: () => new Date(),
  })
}

export async function collectSystemReadiness(
  dependencies: SystemReadinessDependencies,
): Promise<SystemReadinessReport> {
  const [database, runtime, auth, quota, payments, queueHeartbeat, monitorEvidence, backups] = await Promise.all([
    probe(() => dependencies.database()),
    dependencies.runtimeURL
      ? probeJson(() => dependencies.runtime(), runtimeHealthSchema)
      : Promise.resolve({ ok: false as const }),
    probeJson(() => dependencies.auth(), authHealthSchema),
    probeJson(() => dependencies.quota(), quotaHealthSchema),
    probeJson(() => dependencies.payments(), paymentHealthSchema),
    probe(() => dependencies.queueHeartbeat()),
    dependencies.monitoringEnabled
      ? probe(() => dependencies.monitorEvidence())
      : Promise.resolve({ ok: false as const }),
    dependencies.backupsEnabled ? probe(() => dependencies.backups()) : Promise.resolve({ ok: false as const }),
  ])
  const now = dependencies.now()

  const checks: SystemReadinessCheck[] = [
    database.ok
      ? ready("database", "D1 өгөгдлийн сан", "Өгөгдлийн бүтэц болон холболт хэвийн байна.")
      : degraded("database", "D1 өгөгдлийн сан", "Өгөгдлийн сангийн шалгалт амжилтгүй боллоо."),
    runtime.ok
      ? ready("runtime", "Ажиллах үеийн орчин", `${runtime.value.version} хувилбар хариу өгч байна.`)
      : dependencies.runtimeURL
        ? degraded("runtime", "Ажиллах үеийн орчин", "Ажиллах орчны бэлэн байдлын шалгалт амжилтгүй боллоо.")
        : missing("runtime", "Ажиллах үеийн орчин", "Ажиллах орчны URL тохируулагдаагүй байна."),
    auth.ok
      ? ready("oauth", "Нэгдсэн нэвтрэлт", "OAuth үйлчилгээ хариу өгч байна.")
      : degraded("oauth", "Нэгдсэн нэвтрэлт", "OAuth үйлчилгээний бэлэн байдлын шалгалт амжилтгүй боллоо."),
    quota.ok
      ? ready("quota", "Квотын бүртгэл", "Durable Objects-ийн бүртгэл хариу өгч байна.")
      : degraded("quota", "Квотын бүртгэл", "Квотын үйлчилгээний бэлэн байдлын шалгалт амжилтгүй боллоо."),
    queueCheck(queueHeartbeat, now),
    paymentCheck(payments),
    monitoringCheck(monitorEvidence, dependencies.stage, dependencies.monitoringEnabled, now),
    backupCheck(backups, dependencies.stage, dependencies.backupsEnabled, now),
  ]

  return {
    status: checks.every((check) => check.state === "healthy" || check.state === "configured") ? "ok" : "degraded",
    stage: dependencies.stage,
    checks,
    checkedAt: now.toISOString(),
  }
}

function monitoringCheck(
  result: ProbeResult<string | null>,
  stage: string,
  enabled: boolean,
  now: Date,
): SystemReadinessCheck {
  if (!enabled) {
    return {
      id: "monitoring",
      label: "Үйлчилгээний хяналт",
      state: "disabled",
      summary: "Cloudflare-ийн үйлчилгээний автомат хяналт идэвхгүй байна.",
    }
  }
  if (!result.ok || !result.value || result.value.length > 16 * 1024) {
    return degraded("monitoring", "Үйлчилгээний хяналт", "Шинэ хяналтын нотолгоо олдсонгүй.")
  }
  let value: unknown
  try {
    value = JSON.parse(result.value)
  } catch {
    return degraded("monitoring", "Үйлчилгээний хяналт", "Хяналтын нотолгооны бүтэц буруу байна.")
  }
  const parsed = ServiceMonitorEvidenceSchema.safeParse(value)
  if (!parsed.success || parsed.data.stage.toLowerCase() !== stage.toLowerCase()) {
    return degraded("monitoring", "Үйлчилгээний хяналт", "Хяналтын нотолгооны бүтэц буруу байна.")
  }
  const age = now.getTime() - parsed.data.checkedAt
  if (age < -FUTURE_CLOCK_SKEW_MS || age > SERVICE_MONITOR_MAX_AGE_MS) {
    return degraded("monitoring", "Үйлчилгээний хяналт", "Хяналтын нотолгооны хугацаа хэтэрсэн байна.")
  }
  if (parsed.data.status !== "ok") {
    return degraded("monitoring", "Үйлчилгээний хяналт", "Нэг буюу хэд хэдэн нийтийн үйлчилгээ хариу өгөхгүй байна.")
  }
  return ready("monitoring", "Үйлчилгээний хяналт", "Нийтийн үйлчилгээнүүдийн автомат шалгалт хэвийн байна.")
}

function paymentCheck(result: ProbeResult<z.output<typeof paymentHealthSchema>>): SystemReadinessCheck {
  if (!result.ok) return degraded("payments", "QPay + Bonum", "Төлбөрийн бэлэн байдлын шалгалт амжилтгүй боллоо.")
  if (result.value.environment === "disabled") {
    return {
      id: "payments",
      label: "QPay + Bonum",
      state: "disabled",
      summary: "Төлбөрийн орчин идэвхгүй байна.",
    }
  }
  if (result.value.status !== "ok") {
    return degraded(
      "payments",
      "QPay + Bonum",
      `${environmentLabel(result.value.environment)} орчин бүрэн бэлэн биш байна.`,
    )
  }
  return ready("payments", "QPay + Bonum", `${environmentLabel(result.value.environment)} орчин хэвийн байна.`)
}

function queueCheck(result: ProbeResult<string | null>, now: Date): SystemReadinessCheck {
  if (!result.ok || !result.value || result.value.length > 4_096) {
    return degraded("usage-queue", "Хэрэглээний дараалал", "Дарааллын хяналтын дохио олдсонгүй.")
  }
  let value: unknown
  try {
    value = JSON.parse(result.value)
  } catch {
    return degraded("usage-queue", "Хэрэглээний дараалал", "Дарааллын хяналтын дохио буруу байна.")
  }
  const parsed = UsageQueueHeartbeatEvidenceSchema.safeParse(value)
  if (!parsed.success || parsed.data.processedAt < parsed.data.sentAt) {
    return degraded("usage-queue", "Хэрэглээний дараалал", "Дарааллын хяналтын дохио буруу байна.")
  }
  const age = now.getTime() - parsed.data.processedAt
  if (age < -FUTURE_CLOCK_SKEW_MS || age > USAGE_QUEUE_READINESS_MAX_AGE_MS) {
    return degraded("usage-queue", "Хэрэглээний дараалал", "Дарааллын хяналтын дохионы хугацаа хэтэрсэн байна.")
  }
  return ready("usage-queue", "Хэрэглээний дараалал", "Cloudflare Queue-ийн илгээгч ба боловсруулагч хэвийн байна.")
}

function backupCheck(
  result: ProbeResult<{ objects: unknown[] }>,
  stage: string,
  enabled: boolean,
  now: Date,
): SystemReadinessCheck {
  if (!enabled) {
    return {
      id: "backup",
      label: "D1 нөөц хуулбар",
      state: "disabled",
      summary: "D1 нөөц хуулбарын автоматжуулалт идэвхгүй байна.",
    }
  }
  if (!result.ok) return degraded("backup", "D1 нөөц хуулбар", "R2 нөөц хадгалалтын шалгалт амжилтгүй боллоо.")
  const prefix = `d1/${stage.toLowerCase()}/`
  const latest = result.value.objects
    .map((object) => backupObjectSchema.safeParse(object))
    .filter((entry) => entry.success)
    .map((entry) => entry.data)
    .filter((object) => validBackupEvidence(object, prefix, stage))
    .sort((left, right) => right.uploaded.getTime() - left.uploaded.getTime())[0]
  if (!latest) {
    return degraded("backup", "D1 нөөц хуулбар", "Хүчинтэй D1 нөөц хуулбарын нотолгоо R2-д алга байна.")
  }
  const age = now.getTime() - latest.uploaded.getTime()
  if (age < -FUTURE_CLOCK_SKEW_MS || age > D1_BACKUP_MAX_AGE_MS) {
    return degraded("backup", "D1 нөөц хуулбар", "Сүүлийн D1 нөөц хуулбарын хугацаа хэтэрсэн байна.")
  }
  return ready("backup", "D1 нөөц хуулбар", "Шинэ D1 нөөц хуулбар R2-д баталгаажлаа.")
}

function validBackupEvidence(object: z.output<typeof backupObjectSchema>, prefix: string, stage: string) {
  if (object.customMetadata.stage.toLowerCase() !== stage.toLowerCase()) return false
  const createdAt = new Date(object.customMetadata.createdAt)
  if (Number.isNaN(createdAt.getTime())) return false
  const [day] = createdAt.toISOString().split("T")
  const timestamp = createdAt.toISOString().replaceAll(":", "-")
  const expectedPrefix = `${prefix}${day.replaceAll("-", "/")}/${timestamp}-`
  if (!object.key.startsWith(expectedPrefix)) return false
  const uploadDelay = object.uploaded.getTime() - createdAt.getTime()
  return uploadDelay >= -FUTURE_CLOCK_SKEW_MS && uploadDelay <= D1_BACKUP_MAX_UPLOAD_DELAY_MS
}

async function probe<T>(operation: () => Promise<T>): Promise<ProbeResult<T>> {
  try {
    return { ok: true as const, value: await operation() }
  } catch {
    return { ok: false as const }
  }
}

async function probeJson<T extends z.ZodType>(
  operation: () => Promise<Response>,
  schema: T,
): Promise<ProbeResult<z.output<T>>> {
  const result = await probe(operation)
  if (!result.ok || !result.value.ok || !jsonResponse(result.value)) return { ok: false as const }
  const parsed = schema.safeParse(await result.value.json().catch(() => undefined))
  if (!parsed.success) return { ok: false as const }
  return { ok: true as const, value: parsed.data }
}

function jsonResponse(response: Response) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
}

function ready(id: SystemReadinessCheck["id"], label: string, summary: string): SystemReadinessCheck {
  return { id, label, state: "healthy", summary }
}

function degraded(id: SystemReadinessCheck["id"], label: string, summary: string): SystemReadinessCheck {
  return { id, label, state: "degraded", summary }
}

function missing(id: SystemReadinessCheck["id"], label: string, summary: string): SystemReadinessCheck {
  return { id, label, state: "missing", summary }
}

function environmentLabel(environment: "sandbox" | "production") {
  return environment === "production" ? "Үйлдвэрлэлийн" : "Туршилтын"
}
