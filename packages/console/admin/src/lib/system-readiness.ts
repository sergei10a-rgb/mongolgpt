import { Database } from "@mongolgpt/console-core/drizzle/index.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import { Resource } from "@mongolgpt/console-resource"
import { z } from "zod"

export type SystemReadinessState = "healthy" | "configured" | "degraded" | "disabled" | "missing"

export interface SystemReadinessCheck {
  id: "database" | "runtime" | "oauth" | "quota" | "usage-queue" | "payments" | "backup"
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
  list(options?: { prefix?: string; limit?: number }): Promise<{ objects: unknown[] }>
}

export interface SystemReadinessDependencies {
  stage: string
  runtimeURL: string
  database(): Promise<void>
  auth(): Promise<Response>
  quota(): Promise<Response>
  payments(): Promise<Response>
  runtime(): Promise<Response>
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

export async function getSystemReadiness() {
  const resources = {
    AuthApi: Resource.AuthApi,
    D1Backups: Resource.D1Backups,
    PaymentService: Resource.PaymentService,
    QuotaService: Resource.QuotaService,
  } satisfies {
    AuthApi: WorkerBinding
    D1Backups: BackupBucket
    PaymentService: WorkerBinding
    QuotaService: WorkerBinding
  }
  const stage = process.env.MONGOLGPT_STAGE?.trim() || "unknown"
  const runtimeURL = process.env.MONGOLGPT_RUNTIME_URL?.trim() || ""
  const timeout = () => AbortSignal.timeout(4_000)

  return collectSystemReadiness({
    stage,
    runtimeURL,
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
    backups: () => resources.D1Backups.list({ prefix: `d1/${stage.toLowerCase()}/`, limit: 1 }),
    now: () => new Date(),
  })
}

export async function collectSystemReadiness(
  dependencies: SystemReadinessDependencies,
): Promise<SystemReadinessReport> {
  const [database, runtime, auth, quota, payments, backups] = await Promise.all([
    probe(() => dependencies.database()),
    dependencies.runtimeURL
      ? probeJson(() => dependencies.runtime(), runtimeHealthSchema)
      : Promise.resolve({ ok: false as const }),
    probeJson(() => dependencies.auth(), authHealthSchema),
    probeJson(() => dependencies.quota(), quotaHealthSchema),
    probeJson(() => dependencies.payments(), paymentHealthSchema),
    probe(() => dependencies.backups()),
  ])

  const checks: SystemReadinessCheck[] = [
    database.ok
      ? ready("database", "D1 өгөгдлийн сан", "Schema болон холболт хэвийн байна.")
      : degraded("database", "D1 өгөгдлийн сан", "Өгөгдлийн сангийн probe амжилтгүй боллоо."),
    runtime.ok
      ? ready("runtime", "Agent runtime", `Runtime ${runtime.value.version} хариу өгч байна.`)
      : dependencies.runtimeURL
        ? degraded("runtime", "Agent runtime", "Runtime health шалгалт амжилтгүй боллоо.")
        : missing("runtime", "Agent runtime", "Runtime URL тохируулагдаагүй байна."),
    auth.ok
      ? ready("oauth", "Нэгдсэн нэвтрэлт", "OAuth worker хариу өгч байна.")
      : degraded("oauth", "Нэгдсэн нэвтрэлт", "OAuth worker health шалгалт амжилтгүй боллоо."),
    quota.ok
      ? ready("quota", "Quota ledger", "Durable Objects ledger хариу өгч байна.")
      : degraded("quota", "Quota ledger", "Quota service health шалгалт амжилтгүй боллоо."),
    quota.ok
      ? configured("usage-queue", "Usage queue", "Cloudflare Queues binding тохируулагдсан байна.")
      : degraded("usage-queue", "Usage queue", "Queue readiness-ийг баталгаажуулж чадсангүй."),
    paymentCheck(payments),
    backupCheck(backups),
  ]

  return {
    status: checks.every((check) => check.state === "healthy" || check.state === "configured") ? "ok" : "degraded",
    stage: dependencies.stage,
    checks,
    checkedAt: dependencies.now().toISOString(),
  }
}

function paymentCheck(result: ProbeResult<z.output<typeof paymentHealthSchema>>): SystemReadinessCheck {
  if (!result.ok) return degraded("payments", "QPay + Bonum", "Төлбөрийн health шалгалт амжилтгүй боллоо.")
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

function backupCheck(result: ProbeResult<{ objects: unknown[] }>): SystemReadinessCheck {
  if (!result.ok) return degraded("backup", "D1 нөөц хуулбар", "R2 backup storage шалгалт амжилтгүй боллоо.")
  if (result.value.objects.length) return ready("backup", "D1 нөөц хуулбар", "R2-д нөөц хуулбар байна.")
  return configured("backup", "D1 нөөц хуулбар", "R2 бэлэн, анхны нөөц хуулбар хараахан үүсээгүй байна.")
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

function configured(id: SystemReadinessCheck["id"], label: string, summary: string): SystemReadinessCheck {
  return { id, label, state: "configured", summary }
}

function degraded(id: SystemReadinessCheck["id"], label: string, summary: string): SystemReadinessCheck {
  return { id, label, state: "degraded", summary }
}

function missing(id: SystemReadinessCheck["id"], label: string, summary: string): SystemReadinessCheck {
  return { id, label, state: "missing", summary }
}

function environmentLabel(environment: "sandbox" | "production") {
  return environment === "production" ? "Production" : "Sandbox"
}
