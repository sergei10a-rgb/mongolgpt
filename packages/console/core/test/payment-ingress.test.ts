import { describe, expect, test } from "bun:test"
import { BonumWebhookVerificationError } from "../src/payment-provider/bonum"
import { reconcileQPayCallback, verifyBonumWebhook, type PaymentInvoiceForIngress } from "../src/payment-ingress"

const invoice: PaymentInvoiceForIngress = {
  id: "inv_01JV5T0G9H5Q3N7S2R8M4K6WXA",
  externalInvoiceID: "provider_invoice_1",
  amount: 39_000,
  currency: "MNT",
  createdAt: Date.parse("2026-01-29T10:00:00+08:00"),
}

const paidEvent = {
  provider: "qpay" as const,
  merchantAccountID: "merchant_1",
  externalEventID: "event_1",
  externalInvoiceID: invoice.externalInvoiceID,
  externalPaymentID: "payment_1",
  amount: invoice.amount,
  currency: "MNT" as const,
  type: "paid" as const,
  payloadHash: "a".repeat(64),
  occurredAt: invoice.createdAt + 1_000,
}

describe("payment webhook ingress", () => {
  test("loads a merchant-scoped invoice before QPay reconciliation", async () => {
    const lookups: unknown[] = []
    const reconciliations: unknown[] = []
    const events = await reconcileQPayCallback(
      { reference: invoice.id, callbackPaymentID: "payment_1" },
      {
        adapter: {
          merchantAccountID: "merchant_1",
          async reconcileInvoice(input) {
            reconciliations.push(input)
            return [paidEvent]
          },
        },
        async findInvoice(input) {
          lookups.push(input)
          return invoice
        },
      },
    )

    expect(lookups).toEqual([{ provider: "qpay", merchantAccountID: "merchant_1", reference: invoice.id }])
    expect(reconciliations).toEqual([
      {
        externalInvoiceID: invoice.externalInvoiceID,
        expectedAmount: invoice.amount,
        currency: "MNT",
        callbackPaymentID: "payment_1",
      },
    ])
    expect(events).toEqual([paidEvent])
  })

  test("checks Bonum HMAC before parsing or looking up an invoice", async () => {
    let lookups = 0
    const error = await verifyBonumWebhook(
      { rawBody: JSON.stringify({ body: { transactionId: invoice.id } }), checksum: "bad" },
      {
        adapter: {
          merchantAccountID: "merchant_1",
          async verifyWebhookSignature() {
            throw new BonumWebhookVerificationError("signature")
          },
          async verifyWebhook() {
            throw new Error("must not verify bindings")
          },
        },
        async findInvoice() {
          lookups++
          return invoice
        },
      },
    ).catch((cause) => cause)

    expect(error).toBeInstanceOf(BonumWebhookVerificationError)
    expect(lookups).toBe(0)
  })

  test("binds a signed Bonum webhook to the stored invoice", async () => {
    const rawBody = JSON.stringify({ body: { transactionId: invoice.id } })
    const verifications: unknown[] = []
    const events = await verifyBonumWebhook(
      { rawBody, checksum: "b".repeat(64) },
      {
        adapter: {
          merchantAccountID: "merchant_1",
          async verifyWebhookSignature() {},
          async verifyWebhook(input) {
            verifications.push(input)
            return [{ ...paidEvent, provider: "bonum" as const }]
          },
        },
        async findInvoice(input) {
          expect(input).toEqual({
            provider: "bonum",
            merchantAccountID: "merchant_1",
            reference: invoice.id,
          })
          return invoice
        },
      },
    )

    expect(verifications).toEqual([
      {
        rawBody,
        checksum: "b".repeat(64),
        expectedExternalInvoiceID: invoice.externalInvoiceID,
        expectedReference: invoice.id,
        expectedAmount: invoice.amount,
        currency: "MNT",
        expectedCreatedAt: invoice.createdAt,
      },
    ])
    expect(events).toHaveLength(1)
  })
})
