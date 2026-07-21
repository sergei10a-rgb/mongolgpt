import { describe, expect, test } from "bun:test"
import { createPaymentServiceClient, PaymentServiceClientError } from "./payment-service"

const request = {
  workspaceID: "wrk_01JV5T0G9H5Q3N7S2R8M4K6WXA",
  accountID: "acc_01JV5T0G9H5Q3N7S2R8M4K6WXA",
  requestKey: "650f7299-0f46-4d09-92b7-3f8338672227",
  provider: "qpay" as const,
  plan: "pro" as const,
}

const checkout = {
  invoiceID: "inv_01JV5T0G9H5Q3N7S2R8M4K6WXA",
  status: "ready" as const,
  provider: "qpay" as const,
  plan: "pro" as const,
  amount: 49_000,
  currency: "MNT" as const,
  expiresAt: Date.UTC(2026, 6, 21, 12, 15),
  checkout: {
    provider: "qpay" as const,
    merchantAccountID: "merchant_1",
    externalInvoiceID: "invoice_1",
    qrText: "qpay://invoice_1",
    deepLinks: [],
  },
}

const cancellationRequest = {
  workspaceID: request.workspaceID,
  accountID: request.accountID,
  invoiceID: checkout.invoiceID,
  requestKey: "f0e1c9d6-c02e-42e8-a9ae-4fcf57e1cdd4",
}

const cancellation = {
  invoiceID: checkout.invoiceID,
  provider: "qpay" as const,
  status: "cancelled" as const,
}

describe("payment service client", () => {
  test("sends one authenticated internal request and validates the checkout", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = createPaymentServiceClient({
      token: "test-internal-token-long-enough",
      async fetcher(input, init) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        calls.push({ url, init })
        return Response.json(checkout, { status: 201 })
      },
    })

    expect(await client.createSubscriptionCheckout(request)).toEqual(checkout)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://payments.internal/v1/checkouts/subscription")
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test-internal-token-long-enough")
    const body = calls[0]?.init?.body
    expect(typeof body).toBe("string")
    if (typeof body !== "string") throw new Error("Expected a JSON request body")
    expect(JSON.parse(body)).toEqual(request)
  })

  test("preserves only the service's safe conflict fields", async () => {
    const client = createPaymentServiceClient({
      token: "test-internal-token-long-enough",
      async fetcher() {
        return Response.json(
          {
            error: "Өмнөх төлбөрийн нэхэмжлэх дуусаагүй байна.",
            code: "open_checkout",
            invoiceID: checkout.invoiceID,
            internal: "must not escape",
          },
          { status: 409 },
        )
      },
    })

    const error = await client.createSubscriptionCheckout(request).catch((caught) => caught)
    expect(error).toBeInstanceOf(PaymentServiceClientError)
    expect(error).toMatchObject({
      status: 409,
      message: "Өмнөх төлбөрийн нэхэмжлэх дуусаагүй байна.",
      code: "open_checkout",
      invoiceID: checkout.invoiceID,
    })
    expect(JSON.stringify(error)).not.toContain("must not escape")
  })

  test("fails closed on malformed success and non-JSON responses", async () => {
    const malformed = createPaymentServiceClient({
      token: "test-internal-token-long-enough",
      async fetcher() {
        return Response.json({ ...checkout, amount: 0 })
      },
    })
    const nonJson = createPaymentServiceClient({
      token: "test-internal-token-long-enough",
      async fetcher() {
        return new Response("gateway error", { status: 502 })
      },
    })

    const malformedError = await malformed.createSubscriptionCheckout(request).catch((error) => error)
    const nonJsonError = await nonJson.createSubscriptionCheckout(request).catch((error) => error)
    expect(malformedError).toMatchObject({ status: 502 })
    expect(nonJsonError).toMatchObject({ status: 502 })
  })

  test("sends an authenticated cancellation request and validates the exact result", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = createPaymentServiceClient({
      token: "test-internal-token-long-enough",
      async fetcher(input, init) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        calls.push({ url, init })
        return Response.json(cancellation)
      },
    })

    expect(await client.cancelSubscriptionCheckout(cancellationRequest)).toEqual(cancellation)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://payments.internal/v1/checkouts/subscription/cancel")
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test-internal-token-long-enough")
    const body = calls[0]?.init?.body
    expect(typeof body).toBe("string")
    if (typeof body !== "string") throw new Error("Expected a JSON request body")
    expect(JSON.parse(body)).toEqual(cancellationRequest)
  })

  test("preserves safe cancellation errors and fails closed on malformed responses", async () => {
    const rejected = createPaymentServiceClient({
      token: "test-internal-token-long-enough",
      async fetcher() {
        return Response.json(
          {
            error: "Цуцлалтын үр дүн тодорхойгүй байна.",
            code: "result_unknown",
            internal: "must not escape",
          },
          { status: 422 },
        )
      },
    })
    const malformed = createPaymentServiceClient({
      token: "test-internal-token-long-enough",
      async fetcher() {
        return Response.json({ ...cancellation, provider: "bonum", status: "pending" })
      },
    })
    const nonJson = createPaymentServiceClient({
      token: "test-internal-token-long-enough",
      async fetcher() {
        return new Response("gateway error", { status: 503 })
      },
    })

    const rejectedError = await rejected.cancelSubscriptionCheckout(cancellationRequest).catch((error) => error)
    const malformedError = await malformed.cancelSubscriptionCheckout(cancellationRequest).catch((error) => error)
    const nonJsonError = await nonJson.cancelSubscriptionCheckout(cancellationRequest).catch((error) => error)
    expect(rejectedError).toBeInstanceOf(PaymentServiceClientError)
    expect(rejectedError).toMatchObject({ status: 422, code: "result_unknown" })
    expect(JSON.stringify(rejectedError)).not.toContain("must not escape")
    expect(malformedError).toMatchObject({ status: 502 })
    expect(nonJsonError).toMatchObject({ status: 502 })
  })
})
