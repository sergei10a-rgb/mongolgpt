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
  lte,
  sql,
  sum,
} from "@mongolgpt/console-core/drizzle/index.js"
import { PaymentInvoiceTable, PlanSubscriptionTable, UsageTable } from "@mongolgpt/console-core/schema/billing.sql.js"
import { WorkspaceTable } from "@mongolgpt/console-core/schema/workspace.sql.js"
import type { PlatformAdminContext } from "./admin-context"
import { requirePlatformAdminPermission } from "./admin-auth"

const day = 86_400_000

export const AdminBillingQueryInput = z.object({
  period: z.enum(["7d", "30d", "90d"]).default("30d"),
  provider: z.enum(["all", "qpay", "bonum"]).default("all"),
  status: z.enum(["all", "created", "pending", "paid", "failed", "expired", "cancelled", "refunded"]).default("all"),
})

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
  const paymentProvider = input.provider === "all" ? undefined : eq(PaymentInvoiceTable.provider, input.provider)
  const managedUsage = sql<boolean>`coalesce(json_extract(${UsageTable.enrichment}, '$.plan'), '') <> 'byok'`

  return Database.use(async (tx) => {
    const [paid, refunded, pending, activeSubscriptions, usage, usageBreakdown, recentInvoices] = await Promise.all([
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
            lte(PaymentInvoiceTable.time_verified, period.end),
            isNull(PaymentInvoiceTable.timeDeleted),
            paymentProvider,
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
            lte(PaymentInvoiceTable.time_refunded, period.end),
            isNull(PaymentInvoiceTable.timeDeleted),
            paymentProvider,
          ),
        ),
      tx
        .select({ value: count() })
        .from(PaymentInvoiceTable)
        .where(
          and(
            inArray(PaymentInvoiceTable.status, ["created", "pending"]),
            isNull(PaymentInvoiceTable.timeDeleted),
            paymentProvider,
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
            paymentProvider,
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
            lte(UsageTable.timeCreated, period.end),
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
            lte(UsageTable.timeCreated, period.end),
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
          timeCreated: PaymentInvoiceTable.timeCreated,
          timeVerified: PaymentInvoiceTable.time_verified,
          timeRefunded: PaymentInvoiceTable.time_refunded,
        })
        .from(PaymentInvoiceTable)
        .leftJoin(WorkspaceTable, eq(WorkspaceTable.id, PaymentInvoiceTable.workspace_id))
        .where(
          and(
            gte(PaymentInvoiceTable.timeCreated, period.start),
            lte(PaymentInvoiceTable.timeCreated, period.end),
            isNull(PaymentInvoiceTable.timeDeleted),
            paymentProvider,
            input.status === "all" ? undefined : eq(PaymentInvoiceTable.status, input.status),
          ),
        )
        .orderBy(desc(PaymentInvoiceTable.timeCreated), desc(PaymentInvoiceTable.id))
        .limit(25),
    ])

    const paidAmount = aggregateInteger(paid[0]?.amount)
    const refundedAmount = aggregateInteger(refunded[0]?.amount)
    const usageTotals = normalizeUsage(usage[0])

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
        netRevenueMNT: paidAmount - refundedAmount,
        paidInvoices: paid[0]?.invoices ?? 0,
        refundedInvoices: refunded[0]?.invoices ?? 0,
        pendingInvoices: pending[0]?.value ?? 0,
        activeSubscriptions: activeSubscriptions[0]?.value ?? 0,
        modelCostMicroCents: usageTotals.cost,
        requests: usageTotals.requests,
        tokens: usageTotals.tokens,
        marginAvailable: false as const,
      },
      usage: usageBreakdown.map((row) => ({
        provider: row.provider,
        model: row.model,
        ...normalizeUsage(row),
      })),
      invoices: recentInvoices.map((invoice) => ({
        ...invoice,
        workspaceName: invoice.workspaceName || "Нэргүй ажлын орон зай",
        timeCreated: invoice.timeCreated.toISOString(),
        timeVerified: invoice.timeVerified?.toISOString() ?? null,
        timeRefunded: invoice.timeRefunded?.toISOString() ?? null,
      })),
      generatedAt: now.toISOString(),
    }
  })
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
  const cacheWriteTokens = aggregateInteger(row?.cacheWrite5mTokens) + aggregateInteger(row?.cacheWrite1hTokens)

  return {
    requests: row?.requests ?? 0,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tokens: inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens,
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
