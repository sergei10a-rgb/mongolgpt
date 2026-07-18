import { describe, expect, test } from "bun:test"
import { createPaymentQueueEvent, PaymentQueueEventSchema } from "../src/payment-queue"

const payment = {
  provider: "qpay" as const,
  merchantAccountID: "merchant_payment_test",
  externalEventID: "qpay_event_1",
  externalInvoiceID: "qpay_invoice_1",
  externalPaymentID: "qpay_payment_1",
  amount: 39_000,
  currency: "MNT" as const,
  type: "paid" as const,
  payloadHash: "a".repeat(64),
  occurredAt: 1_769_657_291_559,
}

describe("payment queue message", () => {
  test("creates a bounded, versioned message without provider payloads", () => {
    expect(createPaymentQueueEvent(payment, 1_769_657_300_000)).toEqual({
      version: 1,
      event: payment,
      enqueuedAt: 1_769_657_300_000,
    })
  })

  test("rejects unknown versions, extra fields, and malformed events", () => {
    const valid = createPaymentQueueEvent(payment, 1_769_657_300_000)
    expect(PaymentQueueEventSchema.safeParse({ ...valid, version: 2 }).success).toBe(false)
    expect(PaymentQueueEventSchema.safeParse({ ...valid, rawBody: "{}" }).success).toBe(false)
    expect(
      PaymentQueueEventSchema.safeParse({
        ...valid,
        event: { ...valid.event, payloadHash: "not-a-hash" },
      }).success,
    ).toBe(false)
  })
})
