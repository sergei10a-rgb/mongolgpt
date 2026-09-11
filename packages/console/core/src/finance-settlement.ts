import { z } from "zod"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"
import { and, Database, eq, exists, getTableColumns, isNull, or, type InferSelectModel, type SQL } from "./drizzle"
import { financeCostEntryValues, RecordFinanceCostEntrySchema, recordFinanceCostEntryWithDb } from "./finance-ledger"
import { Identifier } from "./identifier"
import { paymentBatchGuard, type PaymentBatchQuery } from "./payment-ledger"
import { sha256Hex, stableJson } from "./payment-provider"
import {
  FinancePaymentSettlementKinds,
  FinancePaymentSettlementTable,
  FinanceCostEntryTable,
  PaymentEventTable,
  PaymentInvoiceTable,
  PaymentProviders,
} from "./schema/billing.sql"

const identifier = z.string().trim().min(1).max(30)
const externalIdentifier = z.string().trim().min(1).max(255)
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)
const signedAmount = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
const payloadHash = z.string().regex(/^[a-f0-9]{64}$/)

export const RecordFinancePaymentSettlementSchema = z
  .object({
    id: identifier.optional(),
    workspaceID: identifier,
    paymentInvoiceID: identifier,
    paymentEventID: identifier.optional(),
    provider: z.enum(PaymentProviders),
    merchantAccountID: externalIdentifier,
    externalSettlementID: externalIdentifier,
    kind: z.enum(FinancePaymentSettlementKinds),
    grossAmountMNT: signedAmount,
    feeAmountMNT: signedAmount,
    taxAmountMNT: signedAmount,
    netAmountMNT: signedAmount,
    currency: z.literal("MNT").default("MNT"),
    idempotencyKey: externalIdentifier,
    payloadHash,
    effectiveAt: timestamp,
  })
  .strict()
  .superRefine((input, context) => {
    const grossSignIsValid =
      (input.kind === "payment" && input.grossAmountMNT > 0) ||
      (input.kind === "refund" && input.grossAmountMNT < 0) ||
      (input.kind === "adjustment" && input.grossAmountMNT !== 0)
    if (!grossSignIsValid) {
      context.addIssue({
        code: "custom",
        path: ["grossAmountMNT"],
        message: "Тооцооны нийт дүн тухайн төрөлтэйгөө таарахгүй байна",
      })
    }

    const expectedNet = BigInt(input.grossAmountMNT) - BigInt(input.feeAmountMNT) - BigInt(input.taxAmountMNT)
    if (expectedNet !== BigInt(input.netAmountMNT)) {
      context.addIssue({
        code: "custom",
        path: ["netAmountMNT"],
        message: "Тооцооны дүнгүүд тэнцэхгүй байна",
      })
    }
  })

export type RecordFinancePaymentSettlementInput = z.input<typeof RecordFinancePaymentSettlementSchema>

export async function recordFinancePaymentSettlementWithDb(
  db: Database.TxOrDb,
  input: RecordFinancePaymentSettlementInput,
) {
  const settlement = RecordFinancePaymentSettlementSchema.parse(input)
  const invoice = await db
    .select()
    .from(PaymentInvoiceTable)
    .where(eq(PaymentInvoiceTable.id, settlement.paymentInvoiceID))
    .then((rows) => rows[0])
  const event = settlement.paymentEventID
    ? await db
        .select()
        .from(PaymentEventTable)
        .where(eq(PaymentEventTable.id, settlement.paymentEventID))
        .then((rows) => rows[0])
    : undefined
  validatePaymentSettlement(settlement, invoice, event)

  const inserted = await db
    .insert(FinancePaymentSettlementTable)
    .values(paymentSettlementValues(settlement))
    .onConflictDoNothing()
  const stored = await findPaymentSettlement(db, settlement)
  if (!stored) throw new Error("Санхүүгийн төлбөрийн тооцооны давхцлын зөрчил гарлаа")
  assertPaymentSettlementReplay(stored, settlement)
  const costs = []
  for (const input of await paymentSettlementCosts({ ...settlement, id: stored.id })) {
    costs.push(await recordFinanceCostEntryWithDb(db, input))
  }
  return {
    kind: resultChanges(inserted) === 0 ? ("duplicate" as const) : ("created" as const),
    settlement: stored,
    costs,
  }
}

function validatePaymentSettlement(
  settlement: z.infer<typeof RecordFinancePaymentSettlementSchema>,
  invoice: typeof PaymentInvoiceTable.$inferSelect | undefined,
  event: typeof PaymentEventTable.$inferSelect | undefined,
): asserts invoice is typeof PaymentInvoiceTable.$inferSelect {
  if (!invoice || invoice.timeDeleted) throw new Error("Санхүүгийн төлбөрийн тооцоо байхгүй нэхэмжлэл зааж байна")
  if (
    invoice.workspace_id !== settlement.workspaceID ||
    invoice.provider !== settlement.provider ||
    invoice.merchant_account_id !== settlement.merchantAccountID ||
    invoice.currency !== settlement.currency
  ) {
    throw new Error("Санхүүгийн төлбөрийн тооцоо нэхэмжлэлтэй таарахгүй байна")
  }
  if (settlement.kind !== "adjustment" && Math.abs(settlement.grossAmountMNT) !== invoice.amount) {
    throw new Error("Санхүүгийн төлбөрийн тооцооны нийт дүн нэхэмжлэлтэй таарахгүй байна")
  }
  if (
    (settlement.kind === "payment" && !["paid", "refunded"].includes(invoice.status)) ||
    (settlement.kind === "refund" && invoice.status !== "refunded") ||
    (settlement.kind === "adjustment" && !["paid", "refunded"].includes(invoice.status))
  ) {
    throw new Error("Санхүүгийн төлбөрийн тооцоонд баталгаажсан нэхэмжлэлийн төлөв шаардлагатай")
  }

  if (settlement.paymentEventID) {
    if (!event || event.timeDeleted)
      throw new Error("Санхүүгийн төлбөрийн тооцоо байхгүй төлбөрийн үйл явдлыг зааж байна")
    const expectedEventType =
      settlement.kind === "payment" ? "paid" : settlement.kind === "refund" ? "refunded" : undefined
    if (
      event.invoice_id !== invoice.id ||
      event.workspace_id !== invoice.workspace_id ||
      event.provider !== invoice.provider ||
      event.merchant_account_id !== invoice.merchant_account_id ||
      event.external_invoice_id !== invoice.external_invoice_id ||
      (expectedEventType && (event.amount !== invoice.amount || event.currency !== invoice.currency)) ||
      event.outcome === "rejected" ||
      (expectedEventType && event.type !== expectedEventType)
    ) {
      throw new Error("Санхүүгийн төлбөрийн тооцоо төлбөрийн үйл явдалтай таарахгүй байна")
    }
  }
}

function paymentSettlementValues(settlement: z.infer<typeof RecordFinancePaymentSettlementSchema>) {
  return {
    id: settlement.id ?? Identifier.create("financePaymentSettlement"),
    workspace_id: settlement.workspaceID,
    payment_invoice_id: settlement.paymentInvoiceID,
    payment_event_id: settlement.paymentEventID ?? null,
    provider: settlement.provider,
    merchant_account_id: settlement.merchantAccountID,
    external_settlement_id: settlement.externalSettlementID,
    kind: settlement.kind,
    gross_amount_mnt: settlement.grossAmountMNT,
    fee_amount_mnt: settlement.feeAmountMNT,
    tax_amount_mnt: settlement.taxAmountMNT,
    net_amount_mnt: settlement.netAmountMNT,
    currency: settlement.currency,
    idempotency_key: settlement.idempotencyKey,
    payload_hash: settlement.payloadHash,
    time_effective: new Date(settlement.effectiveAt),
  }
}

async function paymentSettlementCosts(
  settlement: z.infer<typeof RecordFinancePaymentSettlementSchema> & { id: string },
) {
  const costs = []
  for (const component of [
    { category: "payment_fee" as const, amountMNT: settlement.feeAmountMNT },
    { category: "tax" as const, amountMNT: settlement.taxAmountMNT },
  ]) {
    if (component.amountMNT === 0) continue
    const direction = component.amountMNT > 0 ? ("debit" as const) : ("credit" as const)
    const componentPayload = {
      version: 1,
      settlementID: settlement.id,
      settlementPayloadHash: settlement.payloadHash,
      category: component.category,
      direction,
      amountMNT: Math.abs(component.amountMNT),
    }
    costs.push(
      RecordFinanceCostEntrySchema.parse({
        workspaceID: settlement.workspaceID,
        category: component.category,
        direction,
        basis: "actual",
        sourceType: "payment_settlement",
        sourceReference: settlement.id,
        paymentInvoiceID: settlement.paymentInvoiceID,
        paymentEventID: settlement.paymentEventID,
        provider: settlement.provider,
        originalAmount: Math.abs(component.amountMNT),
        originalCurrency: "MNT",
        idempotencyKey: `settlement:${settlement.id}:${component.category}`,
        payloadHash: await sha256Hex(stableJson(componentPayload)),
        effectiveAt: settlement.effectiveAt,
      }),
    )
  }

  return costs
}

export async function recordFinancePaymentSettlement(
  input: RecordFinancePaymentSettlementInput,
  dependencies: { batch?: typeof Database.batch } = {},
) {
  const settlement = RecordFinancePaymentSettlementSchema.parse(input)
  const batch = dependencies.batch ?? Database.batch
  const identity = or(
    eq(FinancePaymentSettlementTable.idempotency_key, settlement.idempotencyKey),
    and(
      eq(FinancePaymentSettlementTable.provider, settlement.provider),
      eq(FinancePaymentSettlementTable.merchant_account_id, settlement.merchantAccountID),
      eq(FinancePaymentSettlementTable.external_settlement_id, settlement.externalSettlementID),
    ),
  )
  // One bounded retry handles a concurrent identical insert or a lost commit acknowledgement.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [invoices, events, previous] = await batch((db) => [
      db.select().from(PaymentInvoiceTable).where(eq(PaymentInvoiceTable.id, settlement.paymentInvoiceID)),
      db
        .select()
        .from(PaymentEventTable)
        .where(eq(PaymentEventTable.id, settlement.paymentEventID ?? "")),
      db.select().from(FinancePaymentSettlementTable).where(identity),
    ])
    const invoice = invoices[0]
    const event = events[0]
    validatePaymentSettlement(settlement, invoice, event)
    for (const stored of previous) assertPaymentSettlementReplay(stored, settlement)
    const values = paymentSettlementValues({ ...settlement, id: previous[0]?.id ?? settlement.id })
    const components = await paymentSettlementCosts({ ...settlement, id: values.id })
    const costs = components.map((entry) => financeCostEntryValues(entry, entry.originalAmount * 1_000_000))
    try {
      const result = await batch((db) => {
        const costQueries: PaymentBatchQuery[] = costs.flatMap(({ id, ...cost }) => [
          db
            .insert(FinanceCostEntryTable)
            .values({ id, ...cost })
            .onConflictDoNothing(),
          paymentBatchGuard(
            db,
            exists(db.select().from(FinanceCostEntryTable).where(matchesValues(FinanceCostEntryTable, cost))),
          ),
        ])
        return [
          db.insert(FinancePaymentSettlementTable).values(values).onConflictDoNothing(),
          db.select().from(FinancePaymentSettlementTable).where(eq(FinancePaymentSettlementTable.id, values.id)),
          db
            .select()
            .from(FinanceCostEntryTable)
            .where(
              and(
                eq(FinanceCostEntryTable.source_type, "payment_settlement"),
                eq(FinanceCostEntryTable.source_reference, values.id),
              ),
            ),
          paymentBatchGuard(
            db,
            exists(db.select().from(PaymentInvoiceTable).where(matchesValues(PaymentInvoiceTable, invoice))),
          ),
          ...(event
            ? [
                paymentBatchGuard(
                  db,
                  exists(db.select().from(PaymentEventTable).where(matchesValues(PaymentEventTable, event))),
                ),
              ]
            : []),
          paymentBatchGuard(
            db,
            exists(
              db
                .select()
                .from(FinancePaymentSettlementTable)
                .where(matchesValues(FinancePaymentSettlementTable, values)),
            ),
          ),
          ...costQueries,
          db
            .select()
            .from(FinanceCostEntryTable)
            .where(
              and(
                eq(FinanceCostEntryTable.source_type, "payment_settlement"),
                eq(FinanceCostEntryTable.source_reference, values.id),
              ),
            ),
        ]
      })
      const [inserted, stored, entries] = result
      // The final query follows all inserts/guards in the same atomic batch.
      const committedCosts = result.at(-1) as (typeof FinanceCostEntryTable.$inferSelect)[]
      return {
        kind: resultChanges(inserted) === 0 ? ("duplicate" as const) : ("created" as const),
        settlement: stored[0]!,
        costs: costs.map((cost) => ({
          kind: entries.some((entry) => entry.idempotency_key === cost.idempotency_key)
            ? ("duplicate" as const)
            : ("created" as const),
          entry: committedCosts.find((entry) => entry.idempotency_key === cost.idempotency_key)!,
        })),
      }
    } catch (error) {
      if (attempt !== 0) throw error
      const [replayed] = await batch((db) => [db.select().from(FinancePaymentSettlementTable).where(identity)])
      if (!replayed.length) throw error
      for (const stored of replayed) assertPaymentSettlementReplay(stored, settlement)
    }
  }
  throw new Error("Санхүүгийн төлбөрийн тооцоог хадгалж чадсангүй")
}

function matchesValues<T extends SQLiteTable>(table: T, values: Partial<InferSelectModel<T>>): SQL {
  const columns = getTableColumns(table)
  return and(
    ...Object.entries(values).map(([key, value]) => (value == null ? isNull(columns[key]) : eq(columns[key], value))),
  )!
}

async function findPaymentSettlement(db: Database.TxOrDb, input: z.infer<typeof RecordFinancePaymentSettlementSchema>) {
  const byKey = await db
    .select()
    .from(FinancePaymentSettlementTable)
    .where(eq(FinancePaymentSettlementTable.idempotency_key, input.idempotencyKey))
    .then((rows) => rows[0])
  if (byKey) return byKey
  return db
    .select()
    .from(FinancePaymentSettlementTable)
    .where(
      and(
        eq(FinancePaymentSettlementTable.provider, input.provider),
        eq(FinancePaymentSettlementTable.merchant_account_id, input.merchantAccountID),
        eq(FinancePaymentSettlementTable.external_settlement_id, input.externalSettlementID),
      ),
    )
    .then((rows) => rows[0])
}

function assertPaymentSettlementReplay(
  stored: typeof FinancePaymentSettlementTable.$inferSelect,
  replay: z.infer<typeof RecordFinancePaymentSettlementSchema>,
) {
  if (
    stored.workspace_id !== replay.workspaceID ||
    stored.payment_invoice_id !== replay.paymentInvoiceID ||
    stored.payment_event_id !== (replay.paymentEventID ?? null) ||
    stored.provider !== replay.provider ||
    stored.merchant_account_id !== replay.merchantAccountID ||
    stored.external_settlement_id !== replay.externalSettlementID ||
    stored.kind !== replay.kind ||
    stored.gross_amount_mnt !== replay.grossAmountMNT ||
    stored.fee_amount_mnt !== replay.feeAmountMNT ||
    stored.tax_amount_mnt !== replay.taxAmountMNT ||
    stored.net_amount_mnt !== replay.netAmountMNT ||
    stored.currency !== replay.currency ||
    stored.idempotency_key !== replay.idempotencyKey ||
    stored.payload_hash !== replay.payloadHash ||
    stored.time_effective.getTime() !== replay.effectiveAt
  ) {
    throw new Error("Санхүүгийн төлбөрийн тооцоог дахин тоглуулахад хадгалсан тооцоотой зөрчилдлөө")
  }
}

function resultChanges(result: unknown) {
  if (!result || typeof result !== "object") return 0
  if ("meta" in result && result.meta && typeof result.meta === "object" && "changes" in result.meta) {
    return Number(result.meta.changes ?? 0)
  }
  if ("changes" in result) return Number(result.changes ?? 0)
  return 0
}
