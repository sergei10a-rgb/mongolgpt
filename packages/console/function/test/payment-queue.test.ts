import { describe, expect, spyOn, test } from "bun:test"
import { createPaymentQueueEvent } from "@mongolgpt/console-core/payment-queue.js"
import { createPaymentQueueConsumer } from "../src/payment-queue"

const payment = createPaymentQueueEvent(
  {
    provider: "bonum",
    merchantAccountID: "merchant_payment_test",
    externalEventID: "bonum_event_1",
    externalInvoiceID: "bonum_invoice_1",
    externalPaymentID: "bonum_payment_1",
    amount: 39_000,
    currency: "MNT",
    type: "paid",
    payloadHash: "b".repeat(64),
    occurredAt: 1_769_657_291_559,
  },
  1_769_657_300_000,
)

function message(body: unknown) {
  let acknowledged = 0
  let retried = 0
  return {
    body,
    ack() {
      acknowledged++
    },
    retry() {
      retried++
    },
    result() {
      return { acknowledged, retried }
    },
  }
}

describe("payment queue consumer", () => {
  test("acknowledges an applied event and retries invalid messages", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const applied: unknown[] = []
    const valid = message(payment)
    const invalid = message({ version: 2, event: payment.event })
    const consumer = createPaymentQueueConsumer(async (event) => {
      applied.push(event)
    })

    await consumer.queue({ messages: [valid, invalid] })

    expect(applied).toEqual([payment])
    expect(valid.result()).toEqual({ acknowledged: 1, retried: 0 })
    expect(invalid.result()).toEqual({ acknowledged: 0, retried: 1 })
    expect(errorLog).toHaveBeenCalledTimes(1)
    errorLog.mockRestore()
  })

  test("retries without acknowledging when the ledger transaction fails", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const failed = message(payment)
    const consumer = createPaymentQueueConsumer(async () => {
      throw new Error("D1 unavailable")
    })

    await consumer.queue({ messages: [failed] })

    expect(failed.result()).toEqual({ acknowledged: 0, retried: 1 })
    expect(errorLog).toHaveBeenCalledTimes(1)
    errorLog.mockRestore()
  })
})
