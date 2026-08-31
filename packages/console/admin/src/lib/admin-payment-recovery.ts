import { z } from "zod"
import { and, count, Database, desc, eq, isNull, sql } from "@mongolgpt/console-core/drizzle/index.js"
import { PaymentQueueEventSchema } from "@mongolgpt/console-core/payment-queue.js"
import { retryPaymentRecoveryWithDb, PaymentRecoveryRetryError } from "@mongolgpt/console-core/payment-recovery.js"
import { PaymentRecoveryTable } from "@mongolgpt/console-core/schema/billing.sql.js"
import type { PlatformAdminContext } from "./admin-context"
import {
  AdminAuthorizationError,
  requirePlatformAdminPermission,
  writeAdminAudit,
  writeAdminAuditWithDb,
} from "./admin-auth"
import { AdminMutationRequestError, requireSameOriginAdminMutation } from "./admin-mutation"

const recoveryID = z.string().regex(/^prc_[0-9A-HJKMNP-TV-Z]{26}$/)
const mongolianReason = z
  .string()
  .trim()
  .min(20)
  .max(500)
  .refine((value) => /\p{Script=Cyrillic}/u.test(value), "Тайлбар нь дор хаяж нэг кирилл тэмдэгттэй байна.")

export const AdminPaymentRecoveryRetryInput = z
  .object({
    recoveryID,
    requestKey: z.string().trim().uuid().max(64),
    confirmation: z.literal("retry"),
    reason: mongolianReason,
  })
  .strict()

export interface AdminPaymentRecoveryDependencies {
  transaction: typeof Database.transaction
  writeAdminAudit: typeof writeAdminAudit
  writeAdminAuditWithDb: typeof writeAdminAuditWithDb
  retryPaymentRecoveryWithDb: typeof retryPaymentRecoveryWithDb
}

const adminPaymentRecoveryDependencies: AdminPaymentRecoveryDependencies = {
  transaction: Database.transaction,
  writeAdminAudit,
  writeAdminAuditWithDb,
  retryPaymentRecoveryWithDb,
}

export async function listAdminPaymentRecoveries(context: PlatformAdminContext, now = new Date()) {
  const admin = requirePlatformAdminPermission(context, "billing.read")

  return Database.use(async (db) => {
    const [items, unresolved, manualReview] = await Promise.all([
      db
        .select({
          id: PaymentRecoveryTable.id,
          status: PaymentRecoveryTable.status,
          provider: PaymentRecoveryTable.provider,
          merchant_account_id: PaymentRecoveryTable.merchant_account_id,
          external_event_id: PaymentRecoveryTable.external_event_id,
          external_invoice_id: PaymentRecoveryTable.external_invoice_id,
          attempts: PaymentRecoveryTable.attempts,
          last_error_code: PaymentRecoveryTable.last_error_code,
          time_next_attempt: PaymentRecoveryTable.time_next_attempt,
          time_lease_expires: PaymentRecoveryTable.time_lease_expires,
          time_resolved: PaymentRecoveryTable.time_resolved,
          timeCreated: PaymentRecoveryTable.timeCreated,
          timeUpdated: PaymentRecoveryTable.timeUpdated,
          event: PaymentRecoveryTable.event,
        })
        .from(PaymentRecoveryTable)
        .where(isNull(PaymentRecoveryTable.timeDeleted))
        .orderBy(desc(PaymentRecoveryTable.timeUpdated), desc(PaymentRecoveryTable.id))
        .limit(25),
      db
        .select({ value: count() })
        .from(PaymentRecoveryTable)
        .where(
          and(
            isNull(PaymentRecoveryTable.timeDeleted),
            sql<boolean>`${PaymentRecoveryTable.status} in ('pending', 'processing', 'manual_review')`,
          ),
        )
        .then((rows) => rows[0]?.value ?? 0),
      db
        .select({ value: count() })
        .from(PaymentRecoveryTable)
        .where(and(isNull(PaymentRecoveryTable.timeDeleted), eq(PaymentRecoveryTable.status, "manual_review")))
        .then((rows) => rows[0]?.value ?? 0),
    ])

    return {
      admin,
      canRetry: admin.permissions.includes("payments.recover"),
      generatedAt: now.toISOString(),
      summary: {
        unresolved,
        manualReview,
      },
      items: items.map((item) => {
        const validEvent = PaymentQueueEventSchema.safeParse(item.event).success
        return {
          ...serializeRecovery(item),
          validEvent,
          canRetry: admin.permissions.includes("payments.recover") && item.status === "manual_review" && validEvent,
        }
      }),
    }
  })
}

export async function getAdminPaymentRecoveryDetail(
  context: PlatformAdminContext,
  recoveryIDValue: string,
  now = new Date(),
) {
  const admin = requirePlatformAdminPermission(context, "billing.read")
  const id = recoveryID.safeParse(recoveryIDValue)
  if (!id.success) return { admin, canRetry: false, recovery: null, generatedAt: now.toISOString() }

  return Database.use(async (db) => {
    const record = await db
      .select()
      .from(PaymentRecoveryTable)
      .where(and(eq(PaymentRecoveryTable.id, id.data), isNull(PaymentRecoveryTable.timeDeleted)))
      .limit(1)
      .then((rows) => rows[0])

    if (!record) return { admin, canRetry: false, recovery: null, generatedAt: now.toISOString() }

    const parsedEvent = PaymentQueueEventSchema.safeParse(record.event)
    const retryable =
      admin.permissions.includes("payments.recover") && record.status === "manual_review" && parsedEvent.success
    const event = parsedEvent.success ? parsedEvent.data : null

    return {
      admin,
      canRetry: retryable,
      recovery: {
        ...serializeRecovery(record),
        validEvent: parsedEvent.success,
        messageHash: record.message_hash,
        payloadHash: event?.event.payloadHash ?? null,
        eventType: event?.event.type ?? null,
        externalPaymentID: event?.event.externalPaymentID ?? null,
        amount: event?.event.amount ?? null,
        currency: event?.event.currency ?? null,
        occurredAt: event ? iso(event.event.occurredAt) : null,
        enqueuedAt: event ? iso(event.enqueuedAt) : null,
        retryRequestKey: retryable ? crypto.randomUUID() : null,
        retryDisabledReason: retryable ? null : retryDisabledReason(record.status, parsedEvent.success),
      },
      generatedAt: now.toISOString(),
    }
  })
}

export async function retryAdminPaymentRecovery(
  context: PlatformAdminContext,
  request: Request,
  raw: unknown,
  dependencies: AdminPaymentRecoveryDependencies = adminPaymentRecoveryDependencies,
) {
  const targetID =
    typeof raw === "object" && raw !== null && "recoveryID" in raw && typeof raw.recoveryID === "string"
      ? raw.recoveryID.slice(0, 30)
      : undefined

  try {
    requireSameOriginAdminMutation(request)
    const admin = requirePlatformAdminPermission(context, "payments.recover")
    const input = AdminPaymentRecoveryRetryInput.parse(raw)
    return await dependencies.transaction(async (db) => {
      const result = await dependencies.retryPaymentRecoveryWithDb(db, {
        recoveryID: input.recoveryID,
        now: Date.now(),
      })
      await dependencies.writeAdminAuditWithDb(db, {
        adminID: admin.id,
        actorEmail: admin.email,
        action: "payment_recovery.retry",
        outcome: "success",
        request,
        targetType: "payment_recovery",
        targetID: input.recoveryID,
        metadata: {
          request_key: input.requestKey,
          reason: input.reason,
          before_status: result.previousStatus,
          after_status: result.status,
          previous_attempts: result.previousAttempts,
          next_attempt_at: result.timeNextAttempt?.toISOString() ?? null,
          previous_last_error_code: result.previousLastErrorCode,
        },
      })
      return {
        ok: true as const,
        message: "Сэргээх бүртгэлийг дахин дараалалд орууллаа. Дараагийн хуваарьт ажил аюулгүйгээр боловсруулна.",
      }
    })
  } catch (error) {
    const failure = retryFailure(error)
    try {
      await dependencies.writeAdminAudit({
        adminID: context.id,
        actorEmail: context.email,
        action: "payment_recovery.retry",
        outcome: failure.outcome,
        request,
        targetType: "payment_recovery",
        targetID,
        metadata: { reason: failure.code },
      })
    } catch {
      return { ok: false as const, message: "Давтан оролдох хүсэлтийг үйлдлийн бүртгэлд хадгалж чадсангүй." }
    }
    return { ok: false as const, message: failure.message }
  }
}

function serializeRecovery(
  row: Pick<
    typeof PaymentRecoveryTable.$inferSelect,
    | "id"
    | "status"
    | "provider"
    | "merchant_account_id"
    | "external_event_id"
    | "external_invoice_id"
    | "attempts"
    | "last_error_code"
    | "time_next_attempt"
    | "time_lease_expires"
    | "time_resolved"
    | "timeCreated"
    | "timeUpdated"
  >,
) {
  return {
    id: row.id,
    status: row.status,
    provider: row.provider,
    merchantAccountID: row.merchant_account_id,
    externalEventID: row.external_event_id,
    externalInvoiceID: row.external_invoice_id,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    timeNextAttempt: iso(row.time_next_attempt),
    timeLeaseExpires: iso(row.time_lease_expires),
    timeResolved: iso(row.time_resolved),
    timeCreated: row.timeCreated.toISOString(),
    timeUpdated: row.timeUpdated.toISOString(),
  }
}

function retryDisabledReason(status: string, validEvent: boolean) {
  if (!validEvent) return "Энэ сэргээх бүртгэлд хүчинтэй үйл явдал хадгалагдаагүй тул давтан оролдохгүй."
  if (status === "pending") return "Энэ сэргээх бүртгэл аль хэдийн дахин боловсруулагдахаар хүлээгдэж байна."
  if (status === "processing") return "Энэ сэргээх бүртгэлийг хуваарьт ажил яг одоо боловсруулж байна."
  if (status === "resolved") return "Энэ сэргээх бүртгэл амжилттай шийдэгдсэн тул дахин ажиллуулахгүй."
  return "Энэ сэргээх бүртгэл давтан оролдох нөхцөл хангаагүй байна."
}

function retryFailure(error: unknown) {
  if (error instanceof AdminMutationRequestError) {
    return {
      outcome: "denied" as const,
      code: `request_${error.code}`,
      message: "Аюулгүй байдлын хүсэлтийн шалгалт амжилтгүй боллоо.",
    }
  }
  if (error instanceof AdminAuthorizationError) {
    return { outcome: "denied" as const, code: error.code, message: error.message }
  }
  if (error instanceof z.ZodError) {
    return {
      outcome: "denied" as const,
      code: "invalid_input",
      message: "Давтан оролдох хүсэлтийн мэдээлэл буруу байна.",
    }
  }
  if (error instanceof PaymentRecoveryRetryError) {
    if (error.code === "not_found") {
      return { outcome: "denied" as const, code: error.code, message: "Төлбөрийн сэргээх бүртгэл олдсонгүй." }
    }
    if (error.code === "invalid_event") {
      return {
        outcome: "denied" as const,
        code: error.code,
        message: "Хадгалсан үйл явдал хүчингүй тул энэ сэргээх бүртгэлийг давтан оролдохгүй.",
      }
    }
    return {
      outcome: "denied" as const,
      code: `${error.code}_${error.currentStatus ?? "unknown"}`,
      message: retryDisabledReason(error.currentStatus ?? "unknown", true),
    }
  }
  return {
    outcome: "failure" as const,
    code: "internal_error",
    message: "Сэргээх бүртгэлд давтан оролдох үед дотоод алдаа гарлаа.",
  }
}

function iso(value: Date | number | null) {
  if (value === null) return null
  return (value instanceof Date ? value : new Date(value)).toISOString()
}
