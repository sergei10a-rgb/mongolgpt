import { z } from "zod"
import { and, Database, eq } from "./drizzle"
import { recordFinanceCostEntryWithDb } from "./finance-ledger"
import { Identifier } from "./identifier"
import { sha256Hex, stableJson } from "./payment-provider"
import {
  FinancePaymentSettlementKinds,
  FinancePaymentSettlementTable,
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
  if (!invoice) throw new Error("Санхүүгийн төлбөрийн тооцоо байхгүй нэхэмжлэл зааж байна")
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
    const event = await db
      .select()
      .from(PaymentEventTable)
      .where(eq(PaymentEventTable.id, settlement.paymentEventID))
      .then((rows) => rows[0])
    if (!event) throw new Error("Санхүүгийн төлбөрийн тооцоо байхгүй төлбөрийн үйл явдлыг зааж байна")
    const expectedEventType =
      settlement.kind === "payment" ? "paid" : settlement.kind === "refund" ? "refunded" : undefined
    if (
      event.invoice_id !== invoice.id ||
      event.workspace_id !== invoice.workspace_id ||
      event.provider !== invoice.provider ||
      event.merchant_account_id !== invoice.merchant_account_id ||
      event.outcome === "rejected" ||
      (expectedEventType && event.type !== expectedEventType)
    ) {
      throw new Error("Санхүүгийн төлбөрийн тооцоо төлбөрийн үйл явдалтай таарахгүй байна")
    }
  }

  const inserted = await db
    .insert(FinancePaymentSettlementTable)
    .values({
      id: settlement.id ?? Identifier.create("financePaymentSettlement"),
      workspace_id: settlement.workspaceID,
      payment_invoice_id: settlement.paymentInvoiceID,
      payment_event_id: settlement.paymentEventID,
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
    })
    .onConflictDoNothing()

  const stored = await findPaymentSettlement(db, settlement)
  if (!stored) throw new Error("Санхүүгийн төлбөрийн тооцооны давхцлын зөрчил гарлаа")
  assertPaymentSettlementReplay(stored, settlement)

  const costs = []
  for (const component of [
    { category: "payment_fee" as const, amountMNT: stored.fee_amount_mnt },
    { category: "tax" as const, amountMNT: stored.tax_amount_mnt },
  ]) {
    if (component.amountMNT === 0) continue
    const direction = component.amountMNT > 0 ? ("debit" as const) : ("credit" as const)
    const componentPayload = {
      version: 1,
      settlementID: stored.id,
      settlementPayloadHash: stored.payload_hash,
      category: component.category,
      direction,
      amountMNT: Math.abs(component.amountMNT),
    }
    costs.push(
      await recordFinanceCostEntryWithDb(db, {
        workspaceID: stored.workspace_id,
        category: component.category,
        direction,
        basis: "actual",
        sourceType: "payment_settlement",
        sourceReference: stored.id,
        paymentInvoiceID: stored.payment_invoice_id,
        paymentEventID: stored.payment_event_id ?? undefined,
        provider: stored.provider,
        originalAmount: Math.abs(component.amountMNT),
        originalCurrency: "MNT",
        idempotencyKey: `settlement:${stored.id}:${component.category}`,
        payloadHash: await sha256Hex(stableJson(componentPayload)),
        effectiveAt: stored.time_effective.getTime(),
      }),
    )
  }

  return {
    kind: resultChanges(inserted) === 0 ? ("duplicate" as const) : ("created" as const),
    settlement: stored,
    costs,
  }
}

export function recordFinancePaymentSettlement(input: RecordFinancePaymentSettlementInput) {
  return Database.transaction((db) => recordFinancePaymentSettlementWithDb(db, input))
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
