import { describe, expect, spyOn, test } from "bun:test"
import { createPaymentQueueEvent } from "@mongolgpt/console-core/payment-queue.js"
import { PaymentIngressNotFoundError } from "@mongolgpt/console-core/payment-ingress.js"
import {
  PaymentCheckoutAuthorizationError,
  PaymentCheckoutConflictError,
  PaymentCheckoutCreationError,
} from "@mongolgpt/console-core/payment-checkout.js"
import {
  PaymentCancellationAuthorizationError,
  PaymentCancellationConflictError,
  PaymentCancellationOperationError,
  PaymentCancellationUnavailableError,
  PaymentCancellationUnsupportedError,
} from "@mongolgpt/console-core/payment-cancellation.js"
import { z } from "zod"
import { createPaymentWebhookHandler } from "../src/payment-webhook"

const invoiceID = "inv_01JV5T0G9H5Q3N7S2R8M4K6WXA"
const missingInvoiceID = "inv_01JV5T0G9H5Q3N7S2R8M4K6WXB"
const requestKey = "650f7299-0f46-4d09-92b7-3f8338672227"
const cancellationRequestKey = "f0e1c9d6-c02e-42e8-a9ae-4fcf57e1cdd4"

const checkoutRequest = {
  workspaceID: "wrk_01JV5T0G9H5Q3N7S2R8M4K6WXA",
  accountID: "acc_01JV5T0G9H5Q3N7S2R8M4K6WXA",
  requestKey,
  provider: "qpay" as const,
  plan: "pro" as const,
}

const checkoutResult = {
  invoiceID,
  status: "ready" as const,
  provider: "qpay" as const,
  plan: "pro" as const,
  amount: 39_000,
  currency: "MNT" as const,
  expiresAt: 1_769_658_191_559,
  checkout: {
    provider: "qpay" as const,
    merchantAccountID: "merchant_1",
    externalInvoiceID: "invoice_1",
    qrText: "qpay://invoice_1",
    deepLinks: [],
  },
}

const cancellationRequest = {
  workspaceID: checkoutRequest.workspaceID,
  accountID: checkoutRequest.accountID,
  invoiceID,
  requestKey: cancellationRequestKey,
}

const cancellationResult = {
  invoiceID,
  provider: "qpay" as const,
  status: "cancelled" as const,
}

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

const cancelled = {
  provider: "qpay" as const,
  merchantAccountID: "merchant_1",
  externalEventID: "event_cancelled_1",
  externalInvoiceID: "invoice_1",
  type: "cancelled" as const,
  payloadHash: "b".repeat(64),
  occurredAt: 1_769_657_391_559,
}

describe("payment webhook worker", () => {
  test("requires the internal bearer token before reading a checkout request", async () => {
    let calls = 0
    const handler = createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async createSubscriptionCheckout() {
        calls++
        return checkoutResult
      },
      async enqueue() {},
    })

    const response = await handler(
      new Request("https://pay.dev.mgpt.mn/v1/checkouts/subscription", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutRequest),
      }),
    )

    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const payload: unknown = await response.json()
    expect(payload).toEqual({
      error: "Дотоод төлбөрийн үйлчилгээний зөвшөөрөл хүчингүй байна.",
    })
    expect(calls).toBe(0)
  })

  test("creates an authenticated subscription checkout with an exact response contract", async () => {
    const requests: unknown[] = []
    const handler = createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async createSubscriptionCheckout(input) {
        requests.push(input)
        return checkoutResult
      },
      async enqueue() {},
    })

    const response = await handler(
      new Request("https://pay.dev.mgpt.mn/v1/checkouts/subscription", {
        method: "POST",
        headers: {
          authorization: "Bearer test-internal-token",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(checkoutRequest),
      }),
    )

    expect(response.status).toBe(201)
    expect(response.headers.get("content-type")).toContain("application/json")
    const payload: unknown = await response.json()
    expect(payload).toEqual(checkoutResult)
    expect(requests).toEqual([checkoutRequest])
  })

  test("rejects malformed, unsupported, and disabled checkout requests", async () => {
    let calls = 0
    const configured = createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async createSubscriptionCheckout() {
        calls++
        return checkoutResult
      },
      async enqueue() {},
    })
    const headers = { authorization: "Bearer test-internal-token", "content-type": "application/json" }

    const wrongMethod = await configured(
      new Request("https://pay.dev.mgpt.mn/v1/checkouts/subscription", {
        method: "PUT",
        headers,
        body: JSON.stringify(checkoutRequest),
      }),
    )
    const malformed = await configured(
      new Request("https://pay.dev.mgpt.mn/v1/checkouts/subscription", {
        method: "POST",
        headers,
        body: "{",
      }),
    )
    const invalid = await configured(
      new Request("https://pay.dev.mgpt.mn/v1/checkouts/subscription", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...checkoutRequest, plan: "enterprise" }),
      }),
    )
    const disabled = await createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async enqueue() {},
    })(
      new Request("https://pay.dev.mgpt.mn/v1/checkouts/subscription", {
        method: "POST",
        headers,
        body: JSON.stringify(checkoutRequest),
      }),
    )

    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("POST")
    expect(malformed.status).toBe(400)
    expect(invalid.status).toBe(400)
    expect(disabled.status).toBe(503)
    expect(calls).toBe(0)
  })

  test("returns stable conflict and uncertain creation errors without leaking provider details", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const headers = { authorization: "Bearer test-internal-token", "content-type": "application/json" }
    const request = () =>
      new Request("https://pay.dev.mgpt.mn/v1/checkouts/subscription", {
        method: "POST",
        headers,
        body: JSON.stringify(checkoutRequest),
      })
    const conflict = createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async createSubscriptionCheckout() {
        throw new PaymentCheckoutConflictError("open_checkout", invoiceID)
      },
      async enqueue() {},
    })
    const uncertain = createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async createSubscriptionCheckout() {
        throw new PaymentCheckoutCreationError("unknown", "provider_500")
      },
      async enqueue() {},
    })

    const conflictResponse = await conflict(request())
    const uncertainResponse = await uncertain(request())
    const conflictBody: unknown = await conflictResponse.json()
    const uncertainBody: unknown = await uncertainResponse.json()

    expect(conflictResponse.status).toBe(409)
    expect(conflictBody).toEqual({
      error: "Өмнөх төлбөрийн нэхэмжлэх дуусаагүй байна.",
      code: "open_checkout",
      invoiceID,
    })
    expect(uncertainResponse.status).toBe(503)
    expect(uncertainBody).toEqual({
      error: "Нэхэмжлэхийн төлөв тодорхойгүй байна. Давтан төлөхөөс өмнө дэмжлэгтэй холбогдоно уу.",
      code: "provider_500",
    })
    expect(JSON.stringify(uncertainBody)).not.toContain("failed with HTTP")
    expect(errorLog).toHaveBeenCalledTimes(2)
    errorLog.mockRestore()
  })

  test("returns a fixed authorization error when the account cannot manage workspace billing", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const handler = createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async createSubscriptionCheckout() {
        throw new PaymentCheckoutAuthorizationError()
      },
      async enqueue() {},
    })
    const response = await handler(
      new Request("https://pay.dev.mgpt.mn/v1/checkouts/subscription", {
        method: "POST",
        headers: { authorization: "Bearer test-internal-token", "content-type": "application/json" },
        body: JSON.stringify(checkoutRequest),
      }),
    )

    expect(response.status).toBe(403)
    const payload: unknown = await response.json()
    expect(payload).toEqual({
      error: "Энэ ажлын талбарт төлбөр удирдах эрх алга.",
      code: "workspace_admin_required",
    })
    expect(errorLog).toHaveBeenCalledTimes(1)
    errorLog.mockRestore()
  })

  test("rejects malformed checkout service responses", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const handler = createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async createSubscriptionCheckout() {
        return { ...checkoutResult, amount: 0 }
      },
      async enqueue() {},
    })
    const response = await handler(
      new Request("https://pay.dev.mgpt.mn/v1/checkouts/subscription", {
        method: "POST",
        headers: { authorization: "Bearer test-internal-token", "content-type": "application/json" },
        body: JSON.stringify(checkoutRequest),
      }),
    )

    expect(response.status).toBe(502)
    const payload: unknown = await response.json()
    expect(payload).toEqual({
      error: "Төлбөрийн үйлчилгээ буруу хариу буцаалаа.",
    })
    expect(errorLog).toHaveBeenCalledTimes(1)
    errorLog.mockRestore()
  })

  test("keeps unexpected internal checkout failures on the JSON contract", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const authorization = "Bearer test-internal-token"
    const cases = [
      {
        path: "https://pay.dev.mgpt.mn/v1/checkouts/subscription",
        body: checkoutRequest,
        dependencies: {
          async createSubscriptionCheckout() {
            throw new Error("private checkout failure")
          },
        },
      },
      {
        path: "https://pay.dev.mgpt.mn/v1/checkouts/subscription/cancel",
        body: cancellationRequest,
        dependencies: {
          async cancelSubscriptionCheckout() {
            z.string().parse(1)
            throw new Error("unreachable")
          },
        },
      },
    ]

    for (const item of cases) {
      const handler = createPaymentWebhookHandler({
        internalToken: "test-internal-token",
        ...item.dependencies,
        async enqueue() {},
      })
      const response = await handler(
        new Request(item.path, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(item.body),
        }),
      )
      const payload: unknown = await response.json()

      expect(response.status).toBe(500)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(payload).toEqual({
        error: "Төлбөрийн үйлчилгээний дотоод алдаа гарлаа.",
        code: "internal_error",
      })
      expect(JSON.stringify(payload)).not.toContain("private")
    }
    expect(errorLog).toHaveBeenCalledTimes(cases.length)
    errorLog.mockRestore()
  })

  test("cancels an authenticated checkout and queues its verified cancellation event", async () => {
    const requests: unknown[] = []
    const queued: unknown[] = []
    const handler = createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async cancelSubscriptionCheckout(input) {
        requests.push(input)
        return { result: cancellationResult, event: cancelled }
      },
      async enqueue(events) {
        queued.push(...events)
      },
    })

    const response = await handler(
      new Request("https://pay.dev.mgpt.mn/v1/checkouts/subscription/cancel", {
        method: "POST",
        headers: {
          authorization: "Bearer test-internal-token",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(cancellationRequest),
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    const payload: unknown = await response.json()
    expect(payload).toEqual(cancellationResult)
    expect(requests).toEqual([cancellationRequest])
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ version: 1, event: cancelled })
  })

  test("rejects unauthorized, malformed, oversized, and disabled cancellation requests", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    let calls = 0
    const configured = createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async cancelSubscriptionCheckout() {
        calls++
        return { result: cancellationResult }
      },
      async enqueue() {},
    })
    const path = "https://pay.dev.mgpt.mn/v1/checkouts/subscription/cancel"
    const authorization = { authorization: "Bearer test-internal-token" }

    const unauthorized = await configured(
      new Request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cancellationRequest),
      }),
    )
    const wrongMethod = await configured(new Request(path, { method: "GET", headers: authorization }))
    const wrongType = await configured(
      new Request(path, { method: "POST", headers: authorization, body: JSON.stringify(cancellationRequest) }),
    )
    const malformed = await configured(
      new Request(path, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: "{",
      }),
    )
    const invalid = await configured(
      new Request(path, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ ...cancellationRequest, invoiceID: "invoice_1" }),
      }),
    )
    const oversized = await configured(
      new Request(path, {
        method: "POST",
        headers: {
          ...authorization,
          "content-type": "application/json",
          "content-length": "1000001",
        },
        body: "{}",
      }),
    )
    const disabled = await createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async enqueue() {},
    })(
      new Request(path, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(cancellationRequest),
      }),
    )

    expect(unauthorized.status).toBe(401)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("POST")
    expect(wrongType.status).toBe(400)
    expect(malformed.status).toBe(400)
    expect(invalid.status).toBe(400)
    expect(oversized.status).toBe(413)
    expect(oversized.headers.get("content-type")).toContain("application/json")
    const oversizedPayload: unknown = await oversized.json()
    expect(oversizedPayload).toEqual({ error: "Цуцлах хүсэлт хэт том байна." })
    expect(disabled.status).toBe(503)
    expect(calls).toBe(0)
    expect(errorLog).toHaveBeenCalledTimes(1)
    errorLog.mockRestore()
  })

  test("returns stable cancellation capability and operation errors", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const path = "https://pay.dev.mgpt.mn/v1/checkouts/subscription/cancel"
    const makeRequest = () =>
      new Request(path, {
        method: "POST",
        headers: { authorization: "Bearer test-internal-token", "content-type": "application/json" },
        body: JSON.stringify(cancellationRequest),
      })
    const cases = [
      {
        error: new PaymentCancellationAuthorizationError(),
        status: 403,
        code: "workspace_admin_required",
      },
      {
        error: new PaymentCancellationUnsupportedError("bonum"),
        status: 409,
        code: "provider_cancellation_unsupported",
      },
      {
        error: new PaymentCancellationUnavailableError("qpay"),
        status: 503,
        code: "provider_unavailable",
      },
      { error: new PaymentCancellationConflictError("settled"), status: 409, code: "settled" },
      { error: new PaymentCancellationConflictError("result_unknown"), status: 422, code: "result_unknown" },
      {
        error: new PaymentCancellationOperationError("unknown", "provider_503"),
        status: 503,
        code: "provider_503",
      },
      {
        error: new PaymentCancellationOperationError("failed", "provider_401"),
        status: 502,
        code: "provider_401",
      },
    ]

    for (const item of cases) {
      const handler = createPaymentWebhookHandler({
        internalToken: "test-internal-token",
        async cancelSubscriptionCheckout() {
          throw item.error
        },
        async enqueue() {},
      })
      const response = await handler(makeRequest())
      const payload: unknown = await response.json()
      expect(response.status).toBe(item.status)
      expect(payload).toMatchObject({ code: item.code })
      expect(JSON.stringify(payload)).not.toContain("failed with HTTP")
    }
    expect(errorLog).toHaveBeenCalledTimes(cases.length)
    errorLog.mockRestore()
  })

  test("returns JSON and a replayable error when cancellation event queueing fails", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const handler = createPaymentWebhookHandler({
      internalToken: "test-internal-token",
      async cancelSubscriptionCheckout() {
        return { result: cancellationResult, event: cancelled }
      },
      async enqueue() {
        throw new Error("queue unavailable")
      },
    })
    const response = await handler(
      new Request("https://pay.dev.mgpt.mn/v1/checkouts/subscription/cancel", {
        method: "POST",
        headers: { authorization: "Bearer test-internal-token", "content-type": "application/json" },
        body: JSON.stringify(cancellationRequest),
      }),
    )

    expect(response.status).toBe(503)
    expect(response.headers.get("content-type")).toContain("application/json")
    const payload: unknown = await response.json()
    expect(payload).toEqual({
      error: "Нэхэмжлэх цуцлагдсан боловч төлөв шинэчлэх дараалал түр ажиллахгүй байна. Дахин шалгана уу.",
      code: "queue_unavailable",
    })
    expect(errorLog).toHaveBeenCalledTimes(1)
    errorLog.mockRestore()
  })

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
