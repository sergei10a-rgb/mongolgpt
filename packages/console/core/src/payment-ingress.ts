import { and, Database, eq, isNull } from "./drizzle"
import { PaymentInvoiceTable, PaymentProviders } from "./schema/billing.sql"
import { BonumAdapter, type BonumWebhookVerificationInput } from "./payment-provider/bonum"
import { QPayAdapter } from "./payment-provider/qpay"
import { z } from "zod"

export const PaymentInvoiceReferenceSchema = z
  .string()
  .trim()
  .regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/)

const QPayCallbackInputSchema = z
  .object({
    reference: PaymentInvoiceReferenceSchema,
    callbackPaymentID: z.string().trim().min(1).max(255).optional(),
  })
  .strict()

const BonumWebhookInputSchema = z
  .object({
    rawBody: z.string().min(2).max(1_000_000),
    checksum: z.string().trim().min(1).max(255),
  })
  .strict()

const BonumReferencePayloadSchema = z
  .object({
    body: z
      .object({
        transactionId: PaymentInvoiceReferenceSchema,
      })
      .passthrough(),
  })
  .passthrough()

const PaymentInvoiceLookupSchema = z
  .object({
    provider: z.enum(PaymentProviders),
    merchantAccountID: z.string().trim().min(1).max(255),
    reference: PaymentInvoiceReferenceSchema,
  })
  .strict()

export type PaymentInvoiceForIngress = {
  id: string
  externalInvoiceID: string
  amount: number
  currency: "MNT"
  createdAt: number
}

export type FindPaymentInvoice = (
  input: z.input<typeof PaymentInvoiceLookupSchema>,
) => Promise<PaymentInvoiceForIngress>

export class PaymentIngressNotFoundError extends Error {
  constructor() {
    super("Payment invoice not found")
    this.name = "PaymentIngressNotFoundError"
  }
}

export async function findPaymentInvoice(input: z.input<typeof PaymentInvoiceLookupSchema>) {
  const lookup = PaymentInvoiceLookupSchema.parse(input)
  const invoice = await Database.use((db) =>
    db
      .select({
        id: PaymentInvoiceTable.id,
        externalInvoiceID: PaymentInvoiceTable.external_invoice_id,
        amount: PaymentInvoiceTable.amount,
        currency: PaymentInvoiceTable.currency,
        createdAt: PaymentInvoiceTable.timeCreated,
      })
      .from(PaymentInvoiceTable)
      .where(
        and(
          eq(PaymentInvoiceTable.id, lookup.reference),
          eq(PaymentInvoiceTable.provider, lookup.provider),
          eq(PaymentInvoiceTable.merchant_account_id, lookup.merchantAccountID),
          isNull(PaymentInvoiceTable.timeDeleted),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
  )
  if (!invoice) throw new PaymentIngressNotFoundError()
  return {
    id: invoice.id,
    externalInvoiceID: invoice.externalInvoiceID,
    amount: invoice.amount,
    currency: invoice.currency,
    createdAt: invoice.createdAt.getTime(),
  }
}

export async function reconcileQPayCallback(
  input: z.input<typeof QPayCallbackInputSchema>,
  dependencies: {
    adapter: Pick<QPayAdapter, "merchantAccountID" | "reconcileInvoice">
    findInvoice?: FindPaymentInvoice
  },
) {
  const callback = QPayCallbackInputSchema.parse(input)
  const invoice = await (dependencies.findInvoice ?? findPaymentInvoice)({
    provider: "qpay",
    merchantAccountID: dependencies.adapter.merchantAccountID,
    reference: callback.reference,
  })
  return dependencies.adapter.reconcileInvoice({
    externalInvoiceID: invoice.externalInvoiceID,
    expectedAmount: invoice.amount,
    currency: invoice.currency,
    callbackPaymentID: callback.callbackPaymentID,
  })
}

export async function verifyBonumWebhook(
  input: z.input<typeof BonumWebhookInputSchema>,
  dependencies: {
    adapter: Pick<BonumAdapter, "merchantAccountID" | "verifyWebhookSignature" | "verifyWebhook">
    findInvoice?: FindPaymentInvoice
  },
) {
  const webhook = BonumWebhookInputSchema.parse(input)
  await dependencies.adapter.verifyWebhookSignature(webhook)

  let payload: unknown
  try {
    payload = JSON.parse(webhook.rawBody)
  } catch {
    payload = undefined
  }
  const referencePayload = BonumReferencePayloadSchema.parse(payload)
  const invoice = await (dependencies.findInvoice ?? findPaymentInvoice)({
    provider: "bonum",
    merchantAccountID: dependencies.adapter.merchantAccountID,
    reference: referencePayload.body.transactionId,
  })
  const verification: BonumWebhookVerificationInput = {
    ...webhook,
    expectedExternalInvoiceID: invoice.externalInvoiceID,
    expectedReference: invoice.id,
    expectedAmount: invoice.amount,
    currency: invoice.currency,
    expectedCreatedAt: invoice.createdAt,
  }
  return dependencies.adapter.verifyWebhook(verification)
}
