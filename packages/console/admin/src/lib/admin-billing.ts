import { z } from "zod"
import {
  and,
  count,
  Database,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  sql,
  sum,
} from "@mongolgpt/console-core/drizzle/index.js"
import {
  calculateFinanceGrossMargin,
  getFinanceMarginEvidenceWithDb,
} from "@mongolgpt/console-core/finance-reporting.js"
import {
  PaymentCancellationTable,
  PaymentCheckoutTable,
  PaymentInvoiceTable,
  PaymentRefundTable,
  PlanSubscriptionTable,
  UsageTable,
} from "@mongolgpt/console-core/schema/billing.sql.js"
import { PlatformAdminSubscriptionCheckoutCancellationRequestSchema } from "@mongolgpt/console-core/payment-cancellation-contract.js"
import { PlatformAdminSubscriptionPaymentRefundRequestSchema } from "@mongolgpt/console-core/payment-refund-contract.js"
import { WorkspaceTable } from "@mongolgpt/console-core/schema/workspace.sql.js"
import type { PlatformAdminContext } from "./admin-context"
import { requirePlatformAdminPermission } from "./admin-auth"
import { AdminAuthorizationError, writeAdminAudit } from "./admin-auth"
import { AdminMutationRequestError, requireSameOriginAdminMutation } from "./admin-mutation"
import {
  AdminPaymentCancellationServiceError,
  requestPlatformAdminSubscriptionCheckoutCancellation,
} from "./admin-payment-cancellation.server"
import {
  AdminPaymentRefundServiceError,
  requestPlatformAdminSubscriptionPaymentRefund,
} from "./admin-payment-refund.server"

const day = 86_400_000

export const AdminBillingQueryInput = z.object({
  period: z.enum(["7d", "30d", "90d"]).default("30d"),
  provider: z.enum(["all", "qpay", "bonum"]).default("all"),
  status: z.enum(["all", "created", "pending", "paid", "failed", "expired", "cancelled", "refunded"]).default("all"),
})

export const AdminSubscriptionCheckoutCancellationInput =
  PlatformAdminSubscriptionCheckoutCancellationRequestSchema.extend({
    confirmation: z.literal("cancel"),
  })

export const AdminSubscriptionPaymentRefundInput = PlatformAdminSubscriptionPaymentRefundRequestSchema.extend({
  confirmation: z.literal("refund"),
})

export type AdminCancellationDependencies = {
  writeAudit: typeof writeAdminAudit
  cancelCheckout: typeof requestPlatformAdminSubscriptionCheckoutCancellation
}

const adminCancellationDependencies: AdminCancellationDependencies = {
  writeAudit: writeAdminAudit,
  cancelCheckout: requestPlatformAdminSubscriptionCheckoutCancellation,
}

export type AdminRefundDependencies = {
  writeAudit: typeof writeAdminAudit
  refundPayment: typeof requestPlatformAdminSubscriptionPaymentRefund
}

const adminRefundDependencies: AdminRefundDependencies = {
  writeAudit: writeAdminAudit,
  refundPayment: requestPlatformAdminSubscriptionPaymentRefund,
}

export function adminBillingPeriodBounds(period: z.infer<typeof AdminBillingQueryInput>["period"], now = new Date()) {
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30
  return {
    start: new Date(now.getTime() - days * day),
    end: now,
  }
}

export async function getAdminBilling(context: PlatformAdminContext, raw: unknown, now = new Date()) {
  const admin = requirePlatformAdminPermission(context, "billing.read")
  const input = AdminBillingQueryInput.parse(raw)
  const period = adminBillingPeriodBounds(input.period, now)
  const paymentProviderFilter = input.provider === "all" ? undefined : eq(PaymentInvoiceTable.provider, input.provider)
  const managedUsage = sql<boolean>`coalesce(json_extract(${UsageTable.enrichment}, '$.plan'), '') <> 'byok'`

  return Database.use(async (tx) => {
    const [paid, refunded, pending, activeSubscriptions, usage, usageBreakdown, recentInvoices, financeEvidence] =
      await Promise.all([
        tx
          .select({
            amount: sum(PaymentInvoiceTable.amount),
            invoices: count(),
          })
          .from(PaymentInvoiceTable)
          .where(
            and(
              inArray(PaymentInvoiceTable.status, ["paid", "refunded"]),
              gte(PaymentInvoiceTable.time_verified, period.start),
              lt(PaymentInvoiceTable.time_verified, period.end),
              isNull(PaymentInvoiceTable.timeDeleted),
              paymentProviderFilter,
            ),
          ),
        tx
          .select({
            amount: sum(PaymentInvoiceTable.amount),
            invoices: count(),
          })
          .from(PaymentInvoiceTable)
          .where(
            and(
              eq(PaymentInvoiceTable.status, "refunded"),
              gte(PaymentInvoiceTable.time_refunded, period.start),
              lt(PaymentInvoiceTable.time_refunded, period.end),
              isNull(PaymentInvoiceTable.timeDeleted),
              paymentProviderFilter,
            ),
          ),
        tx
          .select({ value: count() })
          .from(PaymentInvoiceTable)
          .where(
            and(
              inArray(PaymentInvoiceTable.status, ["created", "pending"]),
              isNull(PaymentInvoiceTable.timeDeleted),
              paymentProviderFilter,
            ),
          ),
        tx
          .select({ value: count() })
          .from(PlanSubscriptionTable)
          .innerJoin(PaymentInvoiceTable, eq(PaymentInvoiceTable.id, PlanSubscriptionTable.invoiceID))
          .where(
            and(
              eq(PlanSubscriptionTable.status, "active"),
              lte(PlanSubscriptionTable.timePeriodStart, period.end),
              gt(PlanSubscriptionTable.timePeriodEnd, period.end),
              isNull(PlanSubscriptionTable.timeDeleted),
              isNull(PaymentInvoiceTable.timeDeleted),
              paymentProviderFilter,
            ),
          ),
        tx
          .select({
            requests: count(),
            inputTokens: sum(UsageTable.inputTokens),
            outputTokens: sum(UsageTable.outputTokens),
            reasoningTokens: sum(UsageTable.reasoningTokens),
            cacheReadTokens: sum(UsageTable.cacheReadTokens),
            cacheWrite5mTokens: sum(UsageTable.cacheWrite5mTokens),
            cacheWrite1hTokens: sum(UsageTable.cacheWrite1hTokens),
            cost: sum(UsageTable.cost),
          })
          .from(UsageTable)
          .where(
            and(
              gte(UsageTable.timeCreated, period.start),
              lt(UsageTable.timeCreated, period.end),
              isNull(UsageTable.timeDeleted),
              managedUsage,
            ),
          ),
        tx
          .select({
            provider: UsageTable.provider,
            model: UsageTable.model,
            requests: count(),
            inputTokens: sum(UsageTable.inputTokens),
            outputTokens: sum(UsageTable.outputTokens),
            reasoningTokens: sum(UsageTable.reasoningTokens),
            cacheReadTokens: sum(UsageTable.cacheReadTokens),
            cacheWrite5mTokens: sum(UsageTable.cacheWrite5mTokens),
            cacheWrite1hTokens: sum(UsageTable.cacheWrite1hTokens),
            cost: sum(UsageTable.cost),
          })
          .from(UsageTable)
          .where(
            and(
              gte(UsageTable.timeCreated, period.start),
              lt(UsageTable.timeCreated, period.end),
              isNull(UsageTable.timeDeleted),
              managedUsage,
            ),
          )
          .groupBy(UsageTable.provider, UsageTable.model)
          .orderBy(desc(sum(UsageTable.cost)))
          .limit(50),
        tx
          .select({
            id: PaymentInvoiceTable.id,
            workspaceID: PaymentInvoiceTable.workspace_id,
            workspaceName: WorkspaceTable.name,
            provider: PaymentInvoiceTable.provider,
            plan: PaymentInvoiceTable.plan,
            amount: PaymentInvoiceTable.amount,
            currency: PaymentInvoiceTable.currency,
            status: PaymentInvoiceTable.status,
            checkoutStatus: PaymentCheckoutTable.status,
            cancellationStatus: PaymentCancellationTable.status,
            refundStatus: PaymentRefundTable.status,
            timeCreated: PaymentInvoiceTable.timeCreated,
            timeVerified: PaymentInvoiceTable.time_verified,
            timeRefunded: PaymentInvoiceTable.time_refunded,
          })
          .from(PaymentInvoiceTable)
          .leftJoin(WorkspaceTable, eq(WorkspaceTable.id, PaymentInvoiceTable.workspace_id))
          .leftJoin(PaymentCheckoutTable, eq(PaymentCheckoutTable.id, PaymentInvoiceTable.id))
          .leftJoin(PaymentCancellationTable, eq(PaymentCancellationTable.invoice_id, PaymentInvoiceTable.id))
          .leftJoin(PaymentRefundTable, eq(PaymentRefundTable.invoice_id, PaymentInvoiceTable.id))
          .where(
            and(
              gte(PaymentInvoiceTable.timeCreated, period.start),
              lt(PaymentInvoiceTable.timeCreated, period.end),
              isNull(PaymentInvoiceTable.timeDeleted),
              paymentProviderFilter,
              input.status === "all" ? undefined : eq(PaymentInvoiceTable.status, input.status),
            ),
          )
          .orderBy(desc(PaymentInvoiceTable.timeCreated), desc(PaymentInvoiceTable.id))
          .limit(25),
        getFinanceMarginEvidenceWithDb(tx, {
          start: period.start,
          end: period.end,
          paymentProvider: input.provider === "all" ? undefined : input.provider,
        }),
      ])

    const paidAmount = aggregateInteger(paid[0]?.amount)
    const refundedAmount = aggregateInteger(refunded[0]?.amount)
    const usageTotals = normalizeUsage(usage[0])
    const netRevenueMNT = adminBillingSafeDifference(paidAmount, refundedAmount)
    const margin = calculateFinanceGrossMargin({
      netRevenueMNT,
      paymentProvider: input.provider,
      evidence: financeEvidence,
    })

    return {
      admin,
      filters: input,
      period: {
        start: period.start.toISOString(),
        end: period.end.toISOString(),
      },
      metrics: {
        grossRevenueMNT: paidAmount,
        refundsMNT: refundedAmount,
        netRevenueMNT,
        paidInvoices: aggregateInteger(paid[0]?.invoices),
        refundedInvoices: aggregateInteger(refunded[0]?.invoices),
        pendingInvoices: aggregateInteger(pending[0]?.value),
        activeSubscriptions: aggregateInteger(activeSubscriptions[0]?.value),
        estimatedModelCostMicroCents: usageTotals.cost,
        actualModelCostMNTMicros: financeEvidence.model.costMNTMicros,
        paymentCostMNTMicros: financeEvidence.payments.costMNTMicros,
        recognizedRevenueMNTMicros: margin.recognizedRevenueMNTMicros,
        requests: usageTotals.requests,
        tokens: usageTotals.tokens,
      },
      finance: {
        ...financeEvidence,
        margin,
      },
      usage: usageBreakdown.map((row) => ({
        provider: row.provider,
        model: row.model,
        ...normalizeUsage(row),
      })),
      invoices: recentInvoices.map((invoice) => {
        const canCancel =
          admin.permissions.includes("payments.cancel") &&
          invoice.provider === "qpay" &&
          (invoice.status === "created" || invoice.status === "pending") &&
          (invoice.checkoutStatus === "ready" || invoice.checkoutStatus === "pending") &&
          invoice.cancellationStatus === null
        const refundNeedsSync = invoice.refundStatus === "refunded" && invoice.status === "paid"
        const refundNeedsProviderCheck = invoice.refundStatus === "unknown" && invoice.status === "paid"
        const canRefund =
          admin.permissions.includes("payments.refund") &&
          invoice.provider === "qpay" &&
          invoice.status === "paid" &&
          invoice.checkoutStatus === "paid" &&
          (invoice.refundStatus === null || refundNeedsSync || refundNeedsProviderCheck)

        return {
          ...invoice,
          workspaceName: invoice.workspaceName || "Нэргүй ажлын орон зай",
          canCancel,
          cancellationRequestKey: canCancel ? crypto.randomUUID() : null,
          canRefund,
          refundRequestKey: canRefund ? crypto.randomUUID() : null,
          refundNeedsSync,
          refundNeedsProviderCheck,
          timeCreated: invoice.timeCreated.toISOString(),
          timeVerified: invoice.timeVerified?.toISOString() ?? null,
          timeRefunded: invoice.timeRefunded?.toISOString() ?? null,
        }
      }),
      generatedAt: now.toISOString(),
    }
  })
}

export async function cancelAdminSubscriptionCheckout(
  context: PlatformAdminContext,
  request: Request,
  raw: unknown,
  dependencies: AdminCancellationDependencies = adminCancellationDependencies,
) {
  const invoiceID =
    typeof raw === "object" && raw !== null && "invoiceID" in raw && typeof raw.invoiceID === "string"
      ? raw.invoiceID.slice(0, 64)
      : undefined
  let admin: PlatformAdminContext
  let input: z.output<typeof AdminSubscriptionCheckoutCancellationInput>
  try {
    requireSameOriginAdminMutation(request)
    admin = requirePlatformAdminPermission(context, "payments.cancel")
    input = AdminSubscriptionCheckoutCancellationInput.parse(raw)
  } catch (error) {
    const failure = adminCancellationFailure(error)
    try {
      await dependencies.writeAudit({
        adminID: context.id,
        actorEmail: context.email,
        action: "payments.cancel",
        outcome: "denied",
        request,
        targetType: "payment_invoice",
        targetID: invoiceID,
        metadata: { reason: failure.code },
      })
    } catch {
      return { ok: false as const, message: "Цуцлалтын татгалзсан хүсэлтийг аудитад бүртгэж чадсангүй." }
    }
    return { ok: false as const, message: failure.message }
  }

  try {
    await dependencies.writeAudit({
      adminID: admin.id,
      actorEmail: admin.email,
      action: "payments.cancel.requested",
      outcome: "success",
      request,
      targetType: "payment_invoice",
      targetID: input.invoiceID,
      metadata: {
        request_key: input.requestKey,
        reason: input.reason,
        state: "requested",
      },
    })
  } catch {
    return { ok: false as const, message: "Цуцлалтын аудит бүртгэгдсэнгүй. Хүсэлт илгээгээгүй." }
  }

  try {
    await dependencies.cancelCheckout({
      invoiceID: input.invoiceID,
      requestKey: input.requestKey,
      reason: input.reason,
    })
  } catch (error) {
    const failure = adminCancellationFailure(error)
    await dependencies
      .writeAudit({
        adminID: admin.id,
        actorEmail: admin.email,
        action: "payments.cancel",
        outcome: failure.outcome,
        request,
        targetType: "payment_invoice",
        targetID: input.invoiceID,
        metadata: {
          request_key: input.requestKey,
          reason: input.reason,
          result: failure.code,
        },
      })
      .catch(() => undefined)
    return { ok: false as const, message: failure.message }
  }

  try {
    await dependencies.writeAudit({
      adminID: admin.id,
      actorEmail: admin.email,
      action: "payments.cancel",
      outcome: "success",
      request,
      targetType: "payment_invoice",
      targetID: input.invoiceID,
      metadata: {
        request_key: input.requestKey,
        reason: input.reason,
        result: "cancelled",
      },
    })
  } catch {
    return { ok: false as const, message: "Цуцлалт хийгдсэн ч эцсийн аудит бүртгэгдсэнгүй. Шууд шалгана уу." }
  }

  return { ok: true as const, message: "QPay нэхэмжлэхийг цуцлах хүсэлтийг амжилттай дуусгалаа." }
}

export async function refundAdminSubscriptionPayment(
  context: PlatformAdminContext,
  request: Request,
  raw: unknown,
  dependencies: AdminRefundDependencies = adminRefundDependencies,
) {
  const invoiceID =
    typeof raw === "object" && raw !== null && "invoiceID" in raw && typeof raw.invoiceID === "string"
      ? raw.invoiceID.slice(0, 64)
      : undefined
  let admin: PlatformAdminContext
  let input: z.output<typeof AdminSubscriptionPaymentRefundInput>
  try {
    requireSameOriginAdminMutation(request)
    admin = requirePlatformAdminPermission(context, "payments.refund")
    input = AdminSubscriptionPaymentRefundInput.parse(raw)
  } catch (error) {
    const failure = adminRefundFailure(error)
    try {
      await dependencies.writeAudit({
        adminID: context.id,
        actorEmail: context.email,
        action: "payments.refund",
        outcome: "denied",
        request,
        targetType: "payment_invoice",
        targetID: invoiceID,
        metadata: { reason: failure.code },
      })
    } catch {
      return { ok: false as const, message: "Буцаалтын татгалзсан хүсэлтийг аудитад бүртгэж чадсангүй." }
    }
    return { ok: false as const, message: failure.message }
  }

  try {
    await dependencies.writeAudit({
      adminID: admin.id,
      actorEmail: admin.email,
      action: "payments.refund.requested",
      outcome: "success",
      request,
      targetType: "payment_invoice",
      targetID: input.invoiceID,
      metadata: {
        request_key: input.requestKey,
        reason: input.reason,
        state: "requested",
      },
    })
  } catch {
    return { ok: false as const, message: "Буцаалтын аудит бүртгэгдсэнгүй. QPay хүсэлт илгээгээгүй." }
  }

  try {
    await dependencies.refundPayment({
      invoiceID: input.invoiceID,
      requestKey: input.requestKey,
      reason: input.reason,
    })
  } catch (error) {
    const failure = adminRefundFailure(error)
    await dependencies
      .writeAudit({
        adminID: admin.id,
        actorEmail: admin.email,
        action: "payments.refund",
        outcome: failure.outcome,
        request,
        targetType: "payment_invoice",
        targetID: input.invoiceID,
        metadata: {
          request_key: input.requestKey,
          reason: input.reason,
          result: failure.code,
        },
      })
      .catch(() => undefined)
    return { ok: false as const, message: failure.message }
  }

  try {
    await dependencies.writeAudit({
      adminID: admin.id,
      actorEmail: admin.email,
      action: "payments.refund",
      outcome: "success",
      request,
      targetType: "payment_invoice",
      targetID: input.invoiceID,
      metadata: {
        request_key: input.requestKey,
        reason: input.reason,
        result: "refunded",
      },
    })
  } catch {
    return { ok: false as const, message: "Буцаалт хийгдсэн ч эцсийн аудит бүртгэгдсэнгүй. Шууд шалгана уу." }
  }

  return { ok: true as const, message: "QPay төлбөрийн бүтэн буцаалтыг амжилттай хүсэж, төлөв шинэчлэлд орууллаа." }
}

function adminCancellationFailure(error: unknown) {
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
    return { outcome: "denied" as const, code: "invalid_input", message: "Цуцлалтын хүсэлтийн өгөгдөл буруу байна." }
  }
  if (error instanceof AdminPaymentCancellationServiceError) {
    return {
      outcome: error.status >= 400 && error.status < 500 ? ("denied" as const) : ("failure" as const),
      code: error.code ?? `payment_service_${error.status}`,
      message: error.message,
    }
  }
  return { outcome: "failure" as const, code: "internal_error", message: "Цуцлалтын дотоод алдаа гарлаа." }
}

function adminRefundFailure(error: unknown) {
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
    return { outcome: "denied" as const, code: "invalid_input", message: "Буцаалтын хүсэлтийн өгөгдөл буруу байна." }
  }
  if (error instanceof AdminPaymentRefundServiceError) {
    return {
      outcome: error.status >= 400 && error.status < 500 ? ("denied" as const) : ("failure" as const),
      code: error.code ?? `payment_service_${error.status}`,
      message: error.message,
    }
  }
  return { outcome: "failure" as const, code: "internal_error", message: "Буцаалтын дотоод алдаа гарлаа." }
}

function normalizeUsage(
  row:
    | {
        requests?: number | null
        inputTokens?: unknown
        outputTokens?: unknown
        reasoningTokens?: unknown
        cacheReadTokens?: unknown
        cacheWrite5mTokens?: unknown
        cacheWrite1hTokens?: unknown
        cost?: unknown
      }
    | undefined,
) {
  const inputTokens = aggregateInteger(row?.inputTokens)
  const outputTokens = aggregateInteger(row?.outputTokens)
  const reasoningTokens = aggregateInteger(row?.reasoningTokens)
  const cacheReadTokens = aggregateInteger(row?.cacheReadTokens)
  const cacheWriteTokens = adminBillingSafeSum(
    aggregateInteger(row?.cacheWrite5mTokens),
    aggregateInteger(row?.cacheWrite1hTokens),
  )

  return {
    requests: aggregateInteger(row?.requests),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tokens: adminBillingSafeSum(inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens),
    cost: aggregateInteger(row?.cost),
  }
}

function aggregateInteger(value: unknown) {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Санхүүгийн нийлбэр утга хүчинтэй бүхэл тоо биш байна.")
  }
  return parsed
}

export function adminBillingSafeSum(...values: number[]) {
  return safeInteger(values.reduce((total, value) => total + BigInt(safeOperand(value)), 0n))
}

export function adminBillingSafeDifference(left: number, right: number) {
  return safeInteger(BigInt(safeOperand(left)) - BigInt(safeOperand(right)))
}

function safeOperand(value: number) {
  if (!Number.isSafeInteger(value)) {
    throw new Error("Санхүүгийн нийлбэр утга хүчинтэй бүхэл тоо биш байна.")
  }
  return value
}

function safeInteger(value: bigint) {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Санхүүгийн нийлбэр утга аюулгүй бүхэл тооны хязгаараас хэтэрсэн байна.")
  }
  return Number(value)
}
