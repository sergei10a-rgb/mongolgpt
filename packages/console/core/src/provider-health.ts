import { and, eq, inArray, lt } from "drizzle-orm"
import { z } from "zod"
import { Database } from "./drizzle"
import { ProviderAttemptTable } from "./schema/provider-health.sql"

const boundedText = (max: number) => z.string().trim().min(1).max(max)

export const ProviderAttemptEventSchema = z
  .object({
    type: z.literal("provider-attempt"),
    version: z.literal(1),
    id: z.string().regex(/^pat_[0-9A-HJKMNP-TV-Z]{26}$/),
    provider: boundedText(255),
    providerKind: boundedText(64).optional(),
    usageMode: z.enum(["managed", "trial"]),
    model: boundedText(255),
    outcome: z.enum(["success", "transient-error", "permanent-error"]),
    responseStatus: z.number().int().min(100).max(599).optional(),
    latencyMs: z.number().int().min(0).max(600_000),
    retryCount: z.number().int().min(0).max(10),
    fallback: z.boolean(),
    timeCreated: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((event, context) => {
    const transientStatus =
      event.responseStatus === 408 || event.responseStatus === 429 || (event.responseStatus ?? 0) >= 500
    if (event.outcome === "success" && event.responseStatus !== 200) {
      context.addIssue({ code: "custom", path: ["responseStatus"], message: "Амжилттай оролдлого HTTP 200 байна." })
    }
    if (event.outcome === "transient-error" && event.responseStatus !== undefined && !transientStatus) {
      context.addIssue({
        code: "custom",
        path: ["responseStatus"],
        message: "Түр алдааны HTTP төлөв retry бодлоготой нийцэхгүй байна.",
      })
    }
    if (
      event.outcome === "permanent-error" &&
      (event.responseStatus === undefined || transientStatus || event.responseStatus === 200)
    ) {
      context.addIssue({
        code: "custom",
        path: ["responseStatus"],
        message: "Байнгын алдаа retry хийхгүй HTTP төлөвтэй байна.",
      })
    }
  })

export type ProviderAttemptEvent = z.infer<typeof ProviderAttemptEventSchema>
export const PROVIDER_ATTEMPT_RETENTION_DAYS = 30
export const PROVIDER_ATTEMPT_RETENTION_MS = PROVIDER_ATTEMPT_RETENTION_DAYS * 24 * 60 * 60 * 1_000

function resultChanges(result: unknown) {
  if (!result || typeof result !== "object") return 0
  if ("meta" in result && result.meta && typeof result.meta === "object" && "changes" in result.meta) {
    return Number(result.meta.changes ?? 0)
  }
  if ("changes" in result) return Number(result.changes ?? 0)
  return 0
}

export async function persistProviderAttemptWithDb(db: Database.TxOrDb, input: ProviderAttemptEvent) {
  const event = ProviderAttemptEventSchema.parse(input)
  const inserted = await db
    .insert(ProviderAttemptTable)
    .values({
      id: event.id,
      provider: event.provider,
      provider_kind: event.providerKind,
      usage_mode: event.usageMode,
      model: event.model,
      outcome: event.outcome,
      response_status: event.responseStatus,
      latency_ms: event.latencyMs,
      retry_count: event.retryCount,
      fallback: event.fallback,
      time_created: new Date(event.timeCreated),
    })
    .onConflictDoNothing()

  if (resultChanges(inserted) > 0) return "inserted" as const

  const stored = await db
    .select()
    .from(ProviderAttemptTable)
    .where(and(eq(ProviderAttemptTable.id, event.id), eq(ProviderAttemptTable.provider, event.provider)))
    .then((rows) => rows[0])
  if (!stored || !sameProviderAttempt(stored, event)) {
    throw new Error(`Нийлүүлэгчийн оролдлого ${event.id}-ийн давхардлын зөрчил гарлаа`)
  }
  return "duplicate" as const
}

export function persistProviderAttempt(input: ProviderAttemptEvent) {
  return Database.use((db) => persistProviderAttemptWithDb(db, input))
}

export async function pruneProviderAttemptsWithDb(
  db: Database.TxOrDb,
  now = Date.now(),
  options: { batchSize?: number; maxBatches?: number } = {},
) {
  const batchSize = Math.min(500, Math.max(1, Math.floor(options.batchSize ?? 500)))
  const maxBatches = Math.min(100, Math.max(1, Math.floor(options.maxBatches ?? 20)))
  const cutoff = new Date(now - PROVIDER_ATTEMPT_RETENTION_MS)
  let deleted = 0
  let complete = false

  for (let batch = 0; batch < maxBatches; batch++) {
    const expired = await db
      .select({ id: ProviderAttemptTable.id })
      .from(ProviderAttemptTable)
      .where(lt(ProviderAttemptTable.time_created, cutoff))
      .limit(batchSize)
    if (!expired.length) {
      complete = true
      break
    }
    await db.delete(ProviderAttemptTable).where(
      inArray(
        ProviderAttemptTable.id,
        expired.map((item) => item.id),
      ),
    )
    deleted += expired.length
    if (expired.length < batchSize) {
      complete = true
      break
    }
  }
  return { deleted, complete, cutoff: cutoff.toISOString() }
}

function sameProviderAttempt(stored: typeof ProviderAttemptTable.$inferSelect, event: ProviderAttemptEvent) {
  return (
    stored.provider === event.provider &&
    stored.provider_kind === (event.providerKind ?? null) &&
    stored.usage_mode === event.usageMode &&
    stored.model === event.model &&
    stored.outcome === event.outcome &&
    stored.response_status === (event.responseStatus ?? null) &&
    stored.latency_ms === event.latencyMs &&
    stored.retry_count === event.retryCount &&
    stored.fallback === event.fallback &&
    stored.time_created.getTime() === event.timeCreated
  )
}
