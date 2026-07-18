import { describe, expect, spyOn, test } from "bun:test"
import { createPaymentQueueEvent } from "@mongolgpt/console-core/payment-queue.js"
import { PaymentIngressNotFoundError } from "@mongolgpt/console-core/payment-ingress.js"
import { createPaymentWebhookHandler } from "../src/payment-webhook"

const invoiceID = "inv_01JV5T0G9H5Q3N7S2R8M4K6WXA"
const missingInvoiceID = "inv_01JV5T0G9H5Q3N7S2R8M4K6WXB"

const paid = {
  provider: "qpay" as const,
  merchantAccountID: "merchant_1",
  externalEventID: "event_1",
  externalInvoiceID: "invoice_1",
  externalPaymentID: "payment_1",
  amount: 39_000,
  currency: "MNT" as const,
  type: "paid" as const,
  payloadHash: "a".repeat(64),
  occurredAt: 1_769_657_291_559,
}

describe("payment webhook worker", () => {
  test("reconciles a QPay callback and enqueues only verified events", async () => {
    const reconciliations: unknown[] = []
    const queued: unknown[] = []
    const handler = createPaymentWebhookHandler({
      async qpay(input) {
        reconciliations.push(input)
        return [paid]
      },
      async enqueue(events) {
        queued.push(...events)
      },
    })
    const response = await handler(
      new Request(`https://pay.dev.mgpt.mn/v1/webhooks/qpay?invoice=${invoiceID}&payment_id=payment_1`),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("SUCCESS")
    expect(reconciliations).toEqual([{ reference: invoiceID, callbackPaymentID: "payment_1" }])
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ version: 1, event: paid })
  })

  test("passes the exact Bonum body and checksum before enqueueing", async () => {
    const rawBody = `{ "body": { "transactionId": "${invoiceID}" } }\n`
    const received: unknown[] = []
    const queued: unknown[] = []
    const handler = createPaymentWebhookHandler({
      async bonum(input) {
        received.push(input)
        return [{ ...paid, provider: "bonum" as const }]
      },
      async enqueue(events) {
        queued.push(...events)
      },
    })
    const response = await handler(
      new Request("https://pay.dev.mgpt.mn/v1/webhooks/bonum", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-checksum-v2": "b".repeat(64),
        },
        body: rawBody,
      }),
    )

    expect(response.status).toBe(200)
    expect(received).toEqual([{ rawBody, checksum: "b".repeat(64) }])
    expect(queued).toHaveLength(1)
  })

  test("does not acknowledge a verified callback when queue delivery fails", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const handler = createPaymentWebhookHandler({
      async qpay() {
        return [paid]
      },
      async enqueue() {
        throw new Error("queue unavailable")
      },
    })
    const response = await handler(new Request(`https://pay.dev.mgpt.mn/v1/webhooks/qpay?invoice=${invoiceID}`))

    expect(response.status).toBe(503)
    expect(await response.text()).toBe("TRY_AGAIN")
    expect(errorLog).toHaveBeenCalledTimes(1)
    errorLog.mockRestore()
  })

  test("returns fixed errors for unknown invoices and disabled providers", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const missing = createPaymentWebhookHandler({
      async qpay() {
        throw new PaymentIngressNotFoundError()
      },
      async enqueue() {},
    })
    const disabled = createPaymentWebhookHandler({
      async enqueue(events) {
        expect(events).toEqual([createPaymentQueueEvent(paid)])
      },
    })

    expect(
      (await missing(new Request(`https://pay.dev.mgpt.mn/v1/webhooks/qpay?invoice=${missingInvoiceID}`))).status,
    ).toBe(404)
    expect((await disabled(new Request(`https://pay.dev.mgpt.mn/v1/webhooks/qpay?invoice=${invoiceID}`))).status).toBe(
      503,
    )
    expect(errorLog).toHaveBeenCalledTimes(1)
    errorLog.mockRestore()
  })

  test("rejects duplicate and malformed QPay references before reconciliation", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    let reconciliations = 0
    let queueWrites = 0
    const handler = createPaymentWebhookHandler({
      async qpay() {
        reconciliations++
        return [paid]
      },
      async enqueue() {
        queueWrites++
      },
    })

    const duplicate = await handler(
      new Request(`https://pay.dev.mgpt.mn/v1/webhooks/qpay?invoice=${invoiceID}&invoice=${invoiceID}`),
    )
    const malformed = await handler(new Request("https://pay.dev.mgpt.mn/v1/webhooks/qpay?invoice=inv_local_1"))

    expect(duplicate.status).toBe(400)
    expect(malformed.status).toBe(400)
    expect(reconciliations).toBe(0)
    expect(queueWrites).toBe(0)
    expect(errorLog).toHaveBeenCalledTimes(2)
    errorLog.mockRestore()
  })

  test("rejects oversized Bonum bodies before verification or queue delivery", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    let verifications = 0
    let queueWrites = 0
    const handler = createPaymentWebhookHandler({
      async bonum() {
        verifications++
        return [{ ...paid, provider: "bonum" as const }]
      },
      async enqueue() {
        queueWrites++
      },
    })
    const response = await handler(
      new Request("https://pay.dev.mgpt.mn/v1/webhooks/bonum", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-checksum-v2": "b".repeat(64),
        },
        body: "x".repeat(1_000_001),
      }),
    )

    expect(response.status).toBe(413)
    expect(verifications).toBe(0)
    expect(queueWrites).toBe(0)
    expect(errorLog).toHaveBeenCalledTimes(1)
    errorLog.mockRestore()
  })
})
