import { z } from "zod"
import { and, count, Database, eq, gte, gt, inArray, isNull, lt, or, sql } from "./drizzle"
import {
  FinanceCostEntryTable,
  FinancePaymentSettlementTable,
  PaymentCheckoutTable,
  PaymentInvoiceTable,
  PaymentProviders,
  UsageTable,
} from "./schema/billing.sql"

const MNT_MICROS_PER_MNT = 1_000_000n
const scopeIdentifier = z.string().trim().min(1).max(30)

export const FinanceMarginEvidenceInput = z
  .object({
    start: z.date(),
    end: z.date(),
    paymentProvider: z.enum(PaymentProviders).optional(),
    workspaceIDs: z.array(scopeIdentifier).min(1).max(250).optional(),
    userIDs: z.array(scopeIdentifier).min(1).max(250).optional(),
    accountID: scopeIdentifier.optional(),
  })
  .strict()
  .refine((input) => input.start.getTime() <= input.end.getTime(), {
    message: "Санхүүгийн тайлангийн эхлэх хугацаа дуусах хугацаанаас хойш байж болохгүй",
    path: ["start"],
  })

export const FinanceMarginUnavailableReasons = [
  "payment_provider_filter",
  "missing_model_costs",
  "unvalued_model_costs",
  "missing_payment_settlements",
  "ambiguous_payment_settlements",
] as const

export type FinanceMarginUnavailableReason = (typeof FinanceMarginUnavailableReasons)[number]

export interface FinanceMarginEvidence {
  model: {
    expectedUsage: number
    coveredUsage: number
    missingUsage: number
    valuedEntries: number
    unvaluedEntries: number
    debitMNTMicros: number
    creditMNTMicros: number
    costMNTMicros: number
    complete: boolean
  }
  payments: {
    expectedEvents: number
    coveredEvents: number
    missingEvents: number
    ambiguousEvents: number
    feeMNTMicros: number | null
    taxMNTMicros: number | null
    revenueAdjustmentMNTMicros: number | null
    costMNTMicros: number | null
    complete: boolean
  }
}

export interface FinanceGrossMargin {
  available: boolean
  recognizedRevenueMNTMicros: number | null
  valueMNTMicros: number | null
  reasons: FinanceMarginUnavailableReason[]
}

export async function getFinanceMarginEvidenceWithDb(
  db: Database.TxOrDb,
  raw: z.input<typeof FinanceMarginEvidenceInput>,
): Promise<FinanceMarginEvidence> {
  const input = FinanceMarginEvidenceInput.parse(raw)
  const managedUsage = sql<boolean>`coalesce(json_extract(${UsageTable.enrichment}, '$.plan'), '') <> 'byok'`
  const nonzeroManagedUsage = and(
    gte(UsageTable.timeCreated, input.start),
    lt(UsageTable.timeCreated, input.end),
    isNull(UsageTable.timeDeleted),
    gt(UsageTable.cost, 0),
    managedUsage,
    input.workspaceIDs ? inArray(UsageTable.workspaceID, input.workspaceIDs) : undefined,
    input.userIDs ? inArray(UsageTable.userID, input.userIDs) : undefined,
  )

  const actualCostCount = sql<number>`(
    select count(*)
    from finance_cost_entry as cost_entry
    where cost_entry.usage_id = ${UsageTable.id}
      and cost_entry.category = 'model_cost'
      and cost_entry.basis = 'actual'
  )`
  const unvaluedActualCostCount = sql<number>`(
    select count(*)
    from finance_cost_entry as cost_entry
    where cost_entry.usage_id = ${UsageTable.id}
      and cost_entry.category = 'model_cost'
      and cost_entry.basis = 'actual'
      and coalesce(
        cost_entry.amount_mnt_micros,
        (
          select valuation.amount_mnt_micros
          from finance_cost_valuation as valuation
          where valuation.cost_entry_id = cost_entry.id
          order by valuation.version desc
          limit 1
        )
      ) is null
  )`
  const resolvedCostMNTMicros = sql<number | null>`coalesce(
    ${FinanceCostEntryTable.amount_mnt_micros},
    (
      select valuation.amount_mnt_micros
      from finance_cost_valuation as valuation
      where valuation.cost_entry_id = ${FinanceCostEntryTable.id}
      order by valuation.version desc
      limit 1
    )
  )`

  const paymentExpected = and(
    inArray(PaymentInvoiceTable.status, ["paid", "refunded"]),
    gte(PaymentInvoiceTable.time_verified, input.start),
    lt(PaymentInvoiceTable.time_verified, input.end),
  )
  const refundExpected = and(
    eq(PaymentInvoiceTable.status, "refunded"),
    gte(PaymentInvoiceTable.time_refunded, input.start),
    lt(PaymentInvoiceTable.time_refunded, input.end),
  )
  const paymentSettlementCount = sql<number>`(
    select count(*)
    from finance_payment_settlement as settlement
    where settlement.payment_invoice_id = ${PaymentInvoiceTable.id}
      and settlement.kind = 'payment'
  )`
  const refundSettlementCount = sql<number>`(
    select count(*)
    from finance_payment_settlement as settlement
    where settlement.payment_invoice_id = ${PaymentInvoiceTable.id}
      and settlement.kind = 'refund'
  )`
  const paymentProvider = input.paymentProvider ? eq(PaymentInvoiceTable.provider, input.paymentProvider) : undefined
  const paymentWorkspaceScope = input.workspaceIDs
    ? inArray(PaymentInvoiceTable.workspace_id, input.workspaceIDs)
    : undefined
  const paymentAccountScope = input.accountID
    ? sql<boolean>`exists (
        select 1
        from ${PaymentCheckoutTable} as scoped_checkout
        where scoped_checkout.provider = ${PaymentInvoiceTable.provider}
          and scoped_checkout.merchant_account_id = ${PaymentInvoiceTable.merchant_account_id}
          and scoped_checkout.external_invoice_id = ${PaymentInvoiceTable.external_invoice_id}
          and scoped_checkout.account_id = ${input.accountID}
          and scoped_checkout.time_deleted is null
      )`
    : undefined

  const [modelCoverageRows, modelCostRows, paymentCoverageRows, paymentCostRows] = await Promise.all([
    db
      .select({
        expectedUsage: count(),
        coveredUsage: sql<number>`coalesce(sum(
          case
            when ${actualCostCount} > 0 and ${unvaluedActualCostCount} = 0 then 1
            else 0
          end
        ), 0)`,
      })
      .from(UsageTable)
      .where(nonzeroManagedUsage),
    db
      .select({
        valuedEntries: sql<number>`coalesce(sum(case when ${resolvedCostMNTMicros} is not null then 1 else 0 end), 0)`,
        unvaluedEntries: sql<number>`coalesce(sum(case when ${resolvedCostMNTMicros} is null then 1 else 0 end), 0)`,
        debitMNTMicros: sql<number>`coalesce(sum(
          case
            when ${FinanceCostEntryTable.direction} = 'debit' then ${resolvedCostMNTMicros}
            else 0
          end
        ), 0)`,
        creditMNTMicros: sql<number>`coalesce(sum(
          case
            when ${FinanceCostEntryTable.direction} = 'credit' then ${resolvedCostMNTMicros}
            else 0
          end
        ), 0)`,
      })
      .from(FinanceCostEntryTable)
      .innerJoin(UsageTable, eq(UsageTable.id, FinanceCostEntryTable.usage_id))
      .where(
        and(
          nonzeroManagedUsage,
          eq(FinanceCostEntryTable.category, "model_cost"),
          eq(FinanceCostEntryTable.basis, "actual"),
        ),
      ),
    db
      .select({
        paymentEvents: sql<number>`coalesce(sum(case when ${paymentExpected} then 1 else 0 end), 0)`,
        coveredPaymentEvents: sql<number>`coalesce(sum(
          case when ${paymentExpected} and ${paymentSettlementCount} = 1 then 1 else 0 end
        ), 0)`,
        missingPaymentEvents: sql<number>`coalesce(sum(
          case when ${paymentExpected} and ${paymentSettlementCount} = 0 then 1 else 0 end
        ), 0)`,
        ambiguousPaymentEvents: sql<number>`coalesce(sum(
          case when ${paymentExpected} and ${paymentSettlementCount} > 1 then 1 else 0 end
        ), 0)`,
        refundEvents: sql<number>`coalesce(sum(case when ${refundExpected} then 1 else 0 end), 0)`,
        coveredRefundEvents: sql<number>`coalesce(sum(
          case when ${refundExpected} and ${refundSettlementCount} = 1 then 1 else 0 end
        ), 0)`,
        missingRefundEvents: sql<number>`coalesce(sum(
          case when ${refundExpected} and ${refundSettlementCount} = 0 then 1 else 0 end
        ), 0)`,
        ambiguousRefundEvents: sql<number>`coalesce(sum(
          case when ${refundExpected} and ${refundSettlementCount} > 1 then 1 else 0 end
        ), 0)`,
      })
      .from(PaymentInvoiceTable)
      .where(
        and(
          isNull(PaymentInvoiceTable.timeDeleted),
          paymentProvider,
          paymentWorkspaceScope,
          paymentAccountScope,
          or(paymentExpected, refundExpected),
        ),
      ),
    // Payment/refund costs follow their invoice event for accrual reporting.
    // Standalone settlement adjustments follow their own effective instant.
    db
      .select({
        feeMNT: sql<number>`coalesce(sum(${FinancePaymentSettlementTable.fee_amount_mnt}), 0)`,
        taxMNT: sql<number>`coalesce(sum(${FinancePaymentSettlementTable.tax_amount_mnt}), 0)`,
        revenueAdjustmentMNT: sql<number>`coalesce(sum(
          case
            when ${FinancePaymentSettlementTable.kind} = 'adjustment'
              then ${FinancePaymentSettlementTable.gross_amount_mnt}
            else 0
          end
        ), 0)`,
      })
      .from(FinancePaymentSettlementTable)
      .innerJoin(PaymentInvoiceTable, eq(PaymentInvoiceTable.id, FinancePaymentSettlementTable.payment_invoice_id))
      .where(
        and(
          isNull(PaymentInvoiceTable.timeDeleted),
          paymentProvider,
          paymentWorkspaceScope,
          paymentAccountScope,
          or(
            and(eq(FinancePaymentSettlementTable.kind, "payment"), paymentExpected),
            and(eq(FinancePaymentSettlementTable.kind, "refund"), refundExpected),
            and(
              eq(FinancePaymentSettlementTable.kind, "adjustment"),
              gte(FinancePaymentSettlementTable.time_effective, input.start),
              lt(FinancePaymentSettlementTable.time_effective, input.end),
            ),
          ),
        ),
      ),
  ])

  const modelCoverage = modelCoverageRows[0]
  const modelCosts = modelCostRows[0]
  const expectedUsage = aggregateNonnegativeInteger(modelCoverage?.expectedUsage)
  const coveredUsage = aggregateNonnegativeInteger(modelCoverage?.coveredUsage)
  const valuedEntries = aggregateNonnegativeInteger(modelCosts?.valuedEntries)
  const unvaluedEntries = aggregateNonnegativeInteger(modelCosts?.unvaluedEntries)
  const debitMNTMicros = aggregateNonnegativeInteger(modelCosts?.debitMNTMicros)
  const creditMNTMicros = aggregateNonnegativeInteger(modelCosts?.creditMNTMicros)
  const modelCostMNTMicros = subtractSafeIntegers(debitMNTMicros, creditMNTMicros)

  const paymentCoverage = paymentCoverageRows[0]
  const paymentEvents = aggregateNonnegativeInteger(paymentCoverage?.paymentEvents)
  const refundEvents = aggregateNonnegativeInteger(paymentCoverage?.refundEvents)
  const coveredPaymentEvents = aggregateNonnegativeInteger(paymentCoverage?.coveredPaymentEvents)
  const coveredRefundEvents = aggregateNonnegativeInteger(paymentCoverage?.coveredRefundEvents)
  const missingPaymentEvents = aggregateNonnegativeInteger(paymentCoverage?.missingPaymentEvents)
  const missingRefundEvents = aggregateNonnegativeInteger(paymentCoverage?.missingRefundEvents)
  const ambiguousPaymentEvents = aggregateNonnegativeInteger(paymentCoverage?.ambiguousPaymentEvents)
  const ambiguousRefundEvents = aggregateNonnegativeInteger(paymentCoverage?.ambiguousRefundEvents)
  const rawFeeMNTMicros = mntToMicros(aggregateSignedInteger(paymentCostRows[0]?.feeMNT))
  const rawTaxMNTMicros = mntToMicros(aggregateSignedInteger(paymentCostRows[0]?.taxMNT))
  const rawRevenueAdjustmentMNTMicros = mntToMicros(aggregateSignedInteger(paymentCostRows[0]?.revenueAdjustmentMNT))
  const expectedEvents = addSafeIntegers(paymentEvents, refundEvents)
  const coveredEvents = addSafeIntegers(coveredPaymentEvents, coveredRefundEvents)
  const missingEvents = addSafeIntegers(missingPaymentEvents, missingRefundEvents)
  const ambiguousEvents = addSafeIntegers(ambiguousPaymentEvents, ambiguousRefundEvents)
  const paymentsComplete = expectedEvents === coveredEvents && missingEvents === 0 && ambiguousEvents === 0
  const feeMNTMicros = paymentsComplete ? rawFeeMNTMicros : null
  const taxMNTMicros = paymentsComplete ? rawTaxMNTMicros : null
  const revenueAdjustmentMNTMicros = paymentsComplete ? rawRevenueAdjustmentMNTMicros : null
  const paymentCostMNTMicros =
    feeMNTMicros === null || taxMNTMicros === null ? null : addSafeIntegers(feeMNTMicros, taxMNTMicros)

  return {
    model: {
      expectedUsage,
      coveredUsage,
      missingUsage: subtractSafeIntegers(expectedUsage, coveredUsage),
      valuedEntries,
      unvaluedEntries,
      debitMNTMicros,
      creditMNTMicros,
      costMNTMicros: modelCostMNTMicros,
      complete: expectedUsage === coveredUsage && unvaluedEntries === 0,
    },
    payments: {
      expectedEvents,
      coveredEvents,
      missingEvents,
      ambiguousEvents,
      feeMNTMicros,
      taxMNTMicros,
      revenueAdjustmentMNTMicros,
      costMNTMicros: paymentCostMNTMicros,
      complete: paymentsComplete,
    },
  }
}

export function getFinanceMarginEvidence(raw: z.input<typeof FinanceMarginEvidenceInput>) {
  return Database.use((db) => getFinanceMarginEvidenceWithDb(db, raw))
}

export function calculateFinanceGrossMargin(input: {
  netRevenueMNT: number
  paymentProvider: "all" | (typeof PaymentProviders)[number]
  evidence: FinanceMarginEvidence
}): FinanceGrossMargin {
  const netRevenueMNT = aggregateSignedInteger(input.netRevenueMNT)
  const reasons: FinanceMarginUnavailableReason[] = []

  if (input.paymentProvider !== "all") reasons.push("payment_provider_filter")
  if (input.evidence.model.missingUsage > 0) reasons.push("missing_model_costs")
  if (input.evidence.model.unvaluedEntries > 0) reasons.push("unvalued_model_costs")
  if (input.evidence.payments.missingEvents > 0) reasons.push("missing_payment_settlements")
  if (input.evidence.payments.ambiguousEvents > 0) reasons.push("ambiguous_payment_settlements")
  if (
    !input.evidence.model.complete &&
    input.evidence.model.missingUsage === 0 &&
    input.evidence.model.unvaluedEntries === 0
  ) {
    reasons.push("missing_model_costs")
  }
  if (
    !input.evidence.payments.complete &&
    input.evidence.payments.missingEvents === 0 &&
    input.evidence.payments.ambiguousEvents === 0
  ) {
    reasons.push("missing_payment_settlements")
  }

  const recognizedRevenueMNTMicros =
    input.evidence.payments.revenueAdjustmentMNTMicros === null
      ? null
      : addSafeIntegers(mntToMicros(netRevenueMNT), input.evidence.payments.revenueAdjustmentMNTMicros)
  if (reasons.length > 0) {
    return {
      available: false,
      recognizedRevenueMNTMicros,
      valueMNTMicros: null,
      reasons,
    }
  }

  if (recognizedRevenueMNTMicros === null || input.evidence.payments.costMNTMicros === null) {
    return {
      available: false,
      recognizedRevenueMNTMicros: null,
      valueMNTMicros: null,
      reasons: ["missing_payment_settlements"],
    }
  }

  return {
    available: true,
    recognizedRevenueMNTMicros,
    valueMNTMicros: subtractSafeIntegers(
      subtractSafeIntegers(recognizedRevenueMNTMicros, input.evidence.model.costMNTMicros),
      input.evidence.payments.costMNTMicros,
    ),
    reasons,
  }
}

function aggregateNonnegativeInteger(value: unknown) {
  const parsed = aggregateSignedInteger(value)
  if (parsed < 0) throw new Error("Санхүүгийн тайлангийн нийлбэр сөрөг байж болохгүй")
  return parsed
}

function aggregateSignedInteger(value: unknown) {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed)) throw new Error("Санхүүгийн тайлангийн нийлбэр аюулгүй бүхэл тоо биш байна")
  return parsed
}

function mntToMicros(value: number) {
  return safeNumber(BigInt(value) * MNT_MICROS_PER_MNT)
}

function addSafeIntegers(left: number, right: number) {
  return safeNumber(BigInt(left) + BigInt(right))
}

function subtractSafeIntegers(left: number, right: number) {
  return safeNumber(BigInt(left) - BigInt(right))
}

function safeNumber(value: bigint) {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Санхүүгийн тайлангийн нийлбэр аюулгүй бүхэл тооны хязгаараас хэтэрлээ")
  }
  return Number(value)
}
