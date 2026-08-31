import { Database } from "@mongolgpt/console-core/drizzle/index.js"
import {
  D1_BACKUP_MANIFEST_MAX_BYTES,
  D1_BACKUP_MANIFEST_SUFFIX,
  d1BackupManifestKey,
  parseD1BackupManifest,
} from "@mongolgpt/console-core/d1-backup-manifest.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import {
  SERVICE_MONITOR_MAX_AGE_MS,
  SERVICE_MONITOR_STATE_KEY,
  PaymentHealthSchema,
  ServiceMonitorEvidenceSchema,
} from "@mongolgpt/console-core/service-monitor.js"
import {
  USAGE_QUEUE_READINESS_MAX_AGE_MS,
  usageQueueReadinessKey,
  UsageQueueHeartbeatEvidenceSchema,
  UsageQueueStageSchema,
} from "@mongolgpt/console-core/usage-queue-readiness.js"
import { Resource } from "@mongolgpt/console-resource"
import { z } from "zod"
import {
  collectPublishedReleaseEvidence,
  type PublishedReleaseEvidence,
  validatePublishedReleaseEvidence,
} from "./release-readiness"

export type SystemReadinessState = "healthy" | "configured" | "degraded" | "disabled" | "missing"

export interface SystemReadinessCheck {
  id: "database" | "runtime" | "oauth" | "quota" | "usage-queue" | "payments" | "monitoring" | "backup" | "release"
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

export type D1BackupBucket = {
  list(options?: {
    prefix?: string
    limit?: number
    cursor?: string
    include?: ("httpMetadata" | "customMetadata")[]
  }): Promise<{ objects: unknown[]; truncated: boolean; cursor?: string }>
  get(key: string): Promise<{
    key: string
    etag: string
    size: number
    uploaded: Date
    httpMetadata?: Record<string, unknown>
    customMetadata?: Record<string, string>
    text(): Promise<string>
  } | null>
  head(key: string): Promise<unknown>
}

export type BackupEvidence = {
  manifestKey: string
  manifestBody: string
  manifestObject: unknown
  artifactObject: unknown
}

export interface SystemReadinessDependencies {
  stage: string
  databaseID: string
  runtimeURL: string
  releaseVersion: string
  backupsEnabled: boolean
  monitoringEnabled: boolean
  database(): Promise<void>
  auth(): Promise<Response>
  quota(): Promise<Response>
  payments(): Promise<Response>
  runtime(): Promise<Response>
  queueHeartbeat(): Promise<string | null>
  monitorEvidence(): Promise<string | null>
  backups(): Promise<BackupEvidence[]>
  release(): Promise<PublishedReleaseEvidence>
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
    etag: z.string().trim().min(1).max(1024),
    httpMetadata: z
      .object({ contentType: z.string().trim().min(1).max(255).optional() })
      .passthrough()
      .default({}),
    customMetadata: z.record(z.string(), z.string()).default({}),
  })
  .passthrough()

const FUTURE_CLOCK_SKEW_MS = 2 * 60 * 1_000
const D1_BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1_000
const D1_BACKUP_MAX_UPLOAD_DELAY_MS = 24 * 60 * 60 * 1_000
const D1_BACKUP_MAX_LIST_PAGES = 10
const D1_BACKUP_MAX_MANIFEST_CANDIDATES = 20

export async function getSystemReadiness() {
  const resources = {
    AuthApi: Resource.AuthApi,
    Database: Resource.Database,
    D1Backups: Resource.D1Backups,
    PaymentService: Resource.PaymentService,
    QuotaService: Resource.QuotaService,
    ServiceMonitorState: Resource.ServiceMonitorState,
    UsageQueueReadiness: Resource.UsageQueueReadiness,
  } satisfies {
    AuthApi: WorkerBinding
    Database: { databaseId: string }
    D1Backups: D1BackupBucket
    PaymentService: WorkerBinding
    QuotaService: WorkerBinding
    ServiceMonitorState: { get(key: string): Promise<string | null> }
    UsageQueueReadiness: { get(key: string): Promise<string | null> }
  }
  const stage = process.env.MONGOLGPT_STAGE?.trim() || "тодорхойгүй"
  const runtimeURL = process.env.MONGOLGPT_RUNTIME_URL?.trim() || ""
  const releaseVersion = process.env.MONGOLGPT_RELEASE_VERSION?.trim() || ""
  const backupsEnabled = process.env.MONGOLGPT_D1_BACKUPS_ENABLED === "true"
  const monitoringEnabled = process.env.MONGOLGPT_MONITORING_ENABLED === "true"
  const timeout = () => AbortSignal.timeout(4_000)

  return collectSystemReadiness({
    stage,
    databaseID: resources.Database.databaseId,
    runtimeURL,
    releaseVersion,
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
    queueHeartbeat: () => resources.UsageQueueReadiness.get(usageQueueReadinessKey(stage)),
    monitorEvidence: () => resources.ServiceMonitorState.get(SERVICE_MONITOR_STATE_KEY),
    backups: () => collectD1BackupEvidence(resources.D1Backups, stage, resources.Database.databaseId),
    release: () => collectPublishedReleaseEvidence({ version: releaseVersion }),
    now: () => new Date(),
  })
}

export async function collectSystemReadiness(
  dependencies: SystemReadinessDependencies,
): Promise<SystemReadinessReport> {
  const [database, runtime, auth, quota, payments, queueHeartbeat, monitorEvidence, backups, release] =
    await Promise.all([
      probe(() => dependencies.database()),
      dependencies.runtimeURL
        ? probeJson(() => dependencies.runtime(), runtimeHealthSchema)
        : Promise.resolve({ ok: false as const }),
      probeJson(() => dependencies.auth(), authHealthSchema),
      probeJson(() => dependencies.quota(), quotaHealthSchema),
      probeJson(() => dependencies.payments(), PaymentHealthSchema),
      probe(() => dependencies.queueHeartbeat()),
      dependencies.monitoringEnabled
        ? probe(() => dependencies.monitorEvidence())
        : Promise.resolve({ ok: false as const }),
      dependencies.backupsEnabled ? probe(() => dependencies.backups()) : Promise.resolve({ ok: false as const }),
      dependencies.releaseVersion ? probe(() => dependencies.release()) : Promise.resolve({ ok: false as const }),
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
    queueCheck(queueHeartbeat, dependencies.stage, now),
    paymentCheck(payments),
    monitoringCheck(monitorEvidence, dependencies.stage, dependencies.monitoringEnabled, now),
    backupCheck(backups, dependencies.stage, dependencies.databaseID, dependencies.backupsEnabled, now),
    releaseCheck(release, dependencies.releaseVersion),
  ]

  return {
    status: checks.every((check) => check.state === "healthy" || check.state === "configured") ? "ok" : "degraded",
    stage: dependencies.stage,
    checks,
    checkedAt: now.toISOString(),
  }
}

function releaseCheck(result: ProbeResult<PublishedReleaseEvidence>, version: string): SystemReadinessCheck {
  if (!version) {
    return missing("release", "Хувилбар ба түгээлт", "Шалгах MongolGPT release хувилбар тохируулагдаагүй байна.")
  }
  if (!result.ok) {
    return degraded("release", "Хувилбар ба түгээлт", `${version} хувилбарын нийтийн түгээлтийг шалгаж чадсангүй.`)
  }
  const errors = validatePublishedReleaseEvidence(result.value)
  if (errors.length) {
    return degraded(
      "release",
      "Хувилбар ба түгээлт",
      `${version} хувилбарын GitHub Release, npm багц эсвэл updater metadata бүрэн нийцээгүй байна (${errors.length} шалгалт).`,
    )
  }
  return ready(
    "release",
    "Хувилбар ба түгээлт",
    `${version} хувилбарын GitHub Release, npm багц, checksum болон updater metadata нийцэж байна.`,
  )
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

function paymentCheck(result: ProbeResult<z.output<typeof PaymentHealthSchema>>): SystemReadinessCheck {
  if (!result.ok) return degraded("payments", "QPay + Bonum", "Төлбөрийн бэлэн байдлын шалгалт амжилтгүй боллоо.")
  if (result.value.status === "degraded") {
    const environment =
      result.value.environment === "disabled"
        ? "Идэвхгүй төлбөрийн орчин"
        : `${environmentLabel(result.value.environment)} орчин`
    return degraded("payments", "QPay + Bonum", `${environment} бүрэн бэлэн биш байна.`)
  }
  if (result.value.environment === "disabled") {
    return {
      id: "payments",
      label: "QPay + Bonum",
      state: "disabled",
      summary: "Төлбөрийн орчин идэвхгүй байна.",
    }
  }
  const capabilityNotice =
    !result.value.cancellation || !result.value.refund
      ? " Цуцлалт ба буцаалт зөвхөн дэмждэг төлбөрийн сувгаар ажиллана."
      : ""
  return ready(
    "payments",
    "QPay + Bonum",
    `${environmentLabel(result.value.environment)} орчны нэхэмжлэх үүсгэх урсгал хэвийн байна.${capabilityNotice}`,
  )
}

function queueCheck(result: ProbeResult<string | null>, stage: string, now: Date): SystemReadinessCheck {
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
  const expectedStage = UsageQueueStageSchema.safeParse(stage)
  if (
    !parsed.success ||
    !expectedStage.success ||
    parsed.data.stage !== expectedStage.data ||
    parsed.data.processedAt < parsed.data.sentAt
  ) {
    return degraded("usage-queue", "Хэрэглээний дараалал", "Дарааллын хяналтын дохио буруу байна.")
  }
  const age = now.getTime() - parsed.data.processedAt
  if (age < -FUTURE_CLOCK_SKEW_MS || age > USAGE_QUEUE_READINESS_MAX_AGE_MS) {
    return degraded("usage-queue", "Хэрэглээний дараалал", "Дарааллын хяналтын дохионы хугацаа хэтэрсэн байна.")
  }
  return ready("usage-queue", "Хэрэглээний дараалал", "Cloudflare Queue-ийн илгээгч ба боловсруулагч хэвийн байна.")
}

function backupCheck(
  result: ProbeResult<BackupEvidence[]>,
  stage: string,
  databaseID: string,
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
  const latest = result.value
    .map((evidence) => validBackupEvidence(evidence, stage, databaseID))
    .filter((evidence) => evidence !== undefined)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]
  if (!latest) {
    return degraded("backup", "D1 нөөц хуулбар", "Хүчинтэй D1 нөөц хуулбарын нотолгоо R2-д алга байна.")
  }
  const age = now.getTime() - latest.createdAt.getTime()
  if (age < -FUTURE_CLOCK_SKEW_MS || age > D1_BACKUP_MAX_AGE_MS) {
    return degraded("backup", "D1 нөөц хуулбар", "Сүүлийн D1 нөөц хуулбарын хугацаа хэтэрсэн байна.")
  }
  return ready("backup", "D1 нөөц хуулбар", "Шинэ D1 нөөц хуулбар R2-д баталгаажлаа.")
}

function validBackupEvidence(evidence: BackupEvidence, stage: string, databaseID: string) {
  const manifestObject = backupObjectSchema.safeParse(evidence.manifestObject)
  const artifactObject = backupObjectSchema.safeParse(evidence.artifactObject)
  if (!manifestObject.success || !artifactObject.success) return undefined
  if (evidence.manifestKey !== manifestObject.data.key) return undefined
  if (manifestObject.data.size !== new TextEncoder().encode(evidence.manifestBody).byteLength) return undefined

  let manifest
  try {
    manifest = parseD1BackupManifest(evidence.manifestBody, {
      stage: stage.toLowerCase(),
      databaseId: databaseID,
    })
  } catch {
    return undefined
  }
  if (evidence.manifestKey !== d1BackupManifestKey(manifest.artifact.key)) return undefined
  if (manifestObject.data.httpMetadata.contentType !== "application/json") return undefined
  if (
    manifestObject.data.customMetadata.createdAt !== manifest.createdAt ||
    manifestObject.data.customMetadata.source !== "mongolgpt-d1-backup-manifest" ||
    manifestObject.data.customMetadata.stage !== manifest.stage ||
    manifestObject.data.customMetadata.databaseId?.toLowerCase() !== manifest.databaseId.toLowerCase() ||
    manifestObject.data.customMetadata.version !== String(manifest.version)
  ) {
    return undefined
  }

  const artifact = artifactObject.data
  if (
    artifact.key !== manifest.artifact.key ||
    artifact.size !== manifest.artifact.size ||
    artifact.etag !== manifest.artifact.etag ||
    artifact.httpMetadata.contentType !== manifest.artifact.contentType ||
    artifact.customMetadata.createdAt !== manifest.createdAt ||
    artifact.customMetadata.source !== manifest.source ||
    artifact.customMetadata.stage !== manifest.stage ||
    artifact.customMetadata.databaseId?.toLowerCase() !== manifest.databaseId.toLowerCase() ||
    artifact.customMetadata.manifestVersion !== String(manifest.version)
  ) {
    return undefined
  }

  const createdAt = new Date(manifest.createdAt)
  const artifactDelay = artifact.uploaded.getTime() - createdAt.getTime()
  const manifestDelay = manifestObject.data.uploaded.getTime() - artifact.uploaded.getTime()
  if (
    artifactDelay < -FUTURE_CLOCK_SKEW_MS ||
    artifactDelay > D1_BACKUP_MAX_UPLOAD_DELAY_MS ||
    manifestDelay < -FUTURE_CLOCK_SKEW_MS ||
    manifestDelay > D1_BACKUP_MAX_UPLOAD_DELAY_MS
  ) {
    return undefined
  }
  return { createdAt }
}

export async function collectD1BackupEvidence(bucket: D1BackupBucket, stage: string, databaseID: string) {
  const objects: unknown[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let complete = false

  for (let page = 0; page < D1_BACKUP_MAX_LIST_PAGES; page++) {
    const result = await bucket.list({
      prefix: `d1/${stage.toLowerCase()}/`,
      limit: 1_000,
      cursor,
      include: ["httpMetadata", "customMetadata"],
    })
    objects.push(...result.objects)
    if (!result.truncated) {
      complete = true
      break
    }
    const next = result.cursor?.trim()
    if (!next || seenCursors.has(next)) throw new Error("R2 D1 нөөц хуулбарын жагсаалтын cursor буруу байна")
    seenCursors.add(next)
    cursor = next
  }
  if (!complete) throw new Error("R2 D1 нөөц хуулбарын жагсаалт зөвшөөрөгдөх хуудасны хязгаараас хэтэрлээ")

  const manifests = objects
    .map((object) => backupObjectSchema.safeParse(object))
    .filter((object) => object.success)
    .map((object) => object.data)
    .filter(
      (object) =>
        object.key.endsWith(D1_BACKUP_MANIFEST_SUFFIX) &&
        object.size > 0 &&
        object.size <= D1_BACKUP_MANIFEST_MAX_BYTES,
    )
    .sort((left, right) => right.key.localeCompare(left.key))
    .slice(0, D1_BACKUP_MAX_MANIFEST_CANDIDATES)

  const evidence = await Promise.all(
    manifests.map(async (listed) => {
      try {
        const stored = await bucket.get(listed.key)
        if (!stored || stored.key !== listed.key || stored.etag !== listed.etag || stored.size !== listed.size) {
          return undefined
        }
        if (stored.size <= 0 || stored.size > D1_BACKUP_MANIFEST_MAX_BYTES) return undefined
        const body = await stored.text()
        if (new TextEncoder().encode(body).byteLength !== stored.size) return undefined
        const manifest = parseD1BackupManifest(body, { stage: stage.toLowerCase(), databaseId: databaseID })
        const artifact = await bucket.head(manifest.artifact.key)
        if (!artifact) return undefined
        return {
          manifestKey: stored.key,
          manifestBody: body,
          manifestObject: stored,
          artifactObject: artifact,
        } satisfies BackupEvidence
      } catch {
        return undefined
      }
    }),
  )
  return evidence.filter((item) => item !== undefined)
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
