import { describe, expect, test } from "bun:test"
import { QPayAdapter } from "../src/payment-provider/qpay"
import { MNTAmountSchema, PaymentProviderResponseError } from "../src/payment-provider"

type MockResponse = {
  status?: number
  body?: unknown
  stream?: ReadableStream<Uint8Array>
  contentType?: string
  contentLength?: string
}

function mockFetch(responses: MockResponse[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error("Unexpected QPay request")
    const status = next.status ?? 200
    if (status === 204) return new Response(null, { status })
    return new Response(next.stream ?? JSON.stringify(next.body ?? {}), {
      status,
      headers: {
        "content-type": next.contentType ?? "application/json",
        ...(next.contentLength === undefined ? {} : { "content-length": next.contentLength }),
      },
    })
  }
  return { fetcher, calls, pending: responses }
}

function adapter(mock: ReturnType<typeof mockFetch>) {
  return new QPayAdapter(
    {
      environment: "sandbox",
      merchantAccountID: "qpay_merchant_test",
      clientID: "client-id",
      clientSecret: "client-secret",
      invoiceCode: "MONGOLGPT_TEST",
      invoiceCallbackURL: "https://dev.mgpt.mn/api/payments/qpay/callback",
    },
    { fetch: mock.fetcher, now: () => 1_000 },
  )
}

function header(init: RequestInit, name: string) {
  if (!init.headers) return undefined
  const value = Reflect.get(init.headers, name)
  return typeof value === "string" ? value : undefined
}

function body(init: RequestInit) {
  if (typeof init.body !== "string") throw new Error("Expected a JSON string request body")
  return JSON.parse(init.body)
}

async function captureError(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject")
}

const token = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 1_800,
  token_type: "Bearer",
}

const paidCheck = {
  count: 1,
  paid_amount: 39_000,
  rows: [
    {
      payment_id: "payment-1",
      payment_status: "PAID",
      payment_date: "2026-07-18T20:00:00.000Z",
      payment_amount: "39000.00",
      payment_currency: "MNT",
    },
  ],
}

describe("QPay Merchant V2 adapter", () => {
  test("creates a sandbox QR invoice and verifies its paid settlement", async () => {
    const mock = mockFetch([
      { body: token },
      {
        body: {
          invoice_id: "invoice-1",
          qr_text: "qpay-qr",
          qr_image: "base64-qr",
          urls: [{ name: "Хаан банк", description: "Хаан банк", link: "khanbank://q?code=1" }],
        },
      },
      { body: paidCheck },
    ])
    const qpay = adapter(mock)

    const checkout = await qpay.createInvoice({
      reference: "inv_local_1",
      customerReference: "customer_1",
      description: "MongolGPT Pro багц",
      amount: 39_000,
      currency: "MNT",
      expiresAt: Date.parse("2026-07-19T20:00:00.000Z"),
    })
    expect(checkout).toEqual({
      provider: "qpay",
      merchantAccountID: "qpay_merchant_test",
      externalInvoiceID: "invoice-1",
      qrText: "qpay-qr",
      qrImage: "base64-qr",
      deepLinks: [{ name: "Хаан банк", description: "Хаан банк", link: "khanbank://q?code=1" }],
    })

    const events = await qpay.reconcileInvoice({
      externalInvoiceID: checkout.externalInvoiceID,
      expectedAmount: 39_000,
      currency: "MNT",
      callbackPaymentID: "payment-1",
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      provider: "qpay",
      merchantAccountID: "qpay_merchant_test",
      externalInvoiceID: "invoice-1",
      externalPaymentID: "payment-1",
      amount: 39_000,
      currency: "MNT",
      type: "paid",
      occurredAt: Date.parse("2026-07-18T20:00:00.000Z"),
    })
    expect(events[0]?.externalEventID).toHaveLength(64)
    expect(events[0]?.payloadHash).toHaveLength(64)

    expect(mock.calls).toHaveLength(3)
    expect(mock.calls[0]?.url).toBe("https://merchant-sandbox.qpay.mn/v2/auth/token")
    expect(header(mock.calls[0].init, "authorization")).toBe(`Basic ${btoa("client-id:client-secret")}`)
    expect(mock.calls[1]?.url).toBe("https://merchant-sandbox.qpay.mn/v2/invoice")
    expect(header(mock.calls[1].init, "authorization")).toBe("Bearer access-token")
    expect(body(mock.calls[1].init)).toMatchObject({
      invoice_code: "MONGOLGPT_TEST",
      sender_invoice_no: "inv_local_1",
      invoice_receiver_code: "customer_1",
      amount: 39_000,
      callback_url: "https://dev.mgpt.mn/api/payments/qpay/callback?invoice=inv_local_1",
      allow_partial: false,
      allow_exceed: false,
      enable_expiry: true,
    })
    expect(mock.calls[2]?.url).toBe("https://merchant-sandbox.qpay.mn/v2/payment/check")
    expect(mock.pending).toHaveLength(0)
  })

  test("does not trust a forged callback payment ID or mismatched amount", async () => {
    const forged = mockFetch([{ body: token }, { body: paidCheck }])
    const forgedHint = QPayAdapter.callbackHint(
      new URL("https://dev.mgpt.mn/api/payments/qpay/callback?payment_id=forged-payment"),
    )
    expect(
      String(
        await captureError(
          adapter(forged).reconcileInvoice({
            externalInvoiceID: "invoice-1",
            expectedAmount: 39_000,
            currency: "MNT",
            callbackPaymentID: forgedHint.paymentID,
          }),
        ),
      ),
    ).toContain("was not present in the verified invoice")

    const amount = mockFetch([{ body: token }, { body: paidCheck }])
    expect(
      String(
        await captureError(
          adapter(amount).reconcileInvoice({
            externalInvoiceID: "invoice-1",
            expectedAmount: 59_000,
            currency: "MNT",
            callbackPaymentID: "payment-1",
          }),
        ),
      ),
    ).toContain("amount or currency does not match")

    const hiddenSettlement = mockFetch([
      { body: token },
      {
        body: {
          count: 2,
          paid_amount: 39_000,
          rows: [
            {
              payment_id: "failed-payment",
              payment_status: "FAILED",
              payment_date: "2026-07-18T19:59:00.000Z",
              payment_amount: 39_000,
              payment_currency: "MNT",
            },
            paidCheck.rows[0],
          ],
        },
      },
    ])
    expect(
      String(
        await captureError(
          adapter(hiddenSettlement).reconcileInvoice({
            externalInvoiceID: "invoice-1",
            expectedAmount: 39_000,
            currency: "MNT",
            callbackPaymentID: "failed-payment",
          }),
        ),
      ),
    ).toContain("does not match the verified settled payment")
  })

  test("rejects a configured callback endpoint with caller-controlled query data", () => {
    const mock = mockFetch([])
    expect(
      () =>
        new QPayAdapter(
          {
            environment: "sandbox",
            merchantAccountID: "qpay_merchant_test",
            clientID: "client-id",
            clientSecret: "client-secret",
            invoiceCode: "MONGOLGPT_TEST",
            invoiceCallbackURL: "https://dev.mgpt.mn/api/payments/qpay/callback?invoice=caller",
          },
          { fetch: mock.fetcher },
        ),
    ).toThrow()
    expect(mock.calls).toHaveLength(0)
  })

  test("reconstructs a refunded settlement as ordered paid and refunded events", async () => {
    const mock = mockFetch([
      { body: token },
      {
        body: {
          ...paidCheck,
          rows: [{ ...paidCheck.rows[0], payment_status: "REFUNDED" }],
        },
      },
    ])
    const events = await adapter(mock).reconcileInvoice({
      externalInvoiceID: "invoice-refunded",
      expectedAmount: 39_000,
      currency: "MNT",
    })

    expect(events.map((event) => event.type)).toEqual(["paid", "refunded"])
    expect(events[0]?.externalPaymentID).toBe("payment-1")
    expect(events[1]?.externalPaymentID).toBe("payment-1")
    expect(events[0]?.externalEventID).not.toBe(events[1]?.externalEventID)
  })

  test("refreshes once after 401 and returns a deterministic pending event", async () => {
    const mock = mockFetch([
      { body: token },
      { status: 401, body: { error: "expired" } },
      { body: { ...token, access_token: "access-token-2" } },
      { body: { count: 0, paid_amount: 0, rows: [] } },
    ])
    const events = await adapter(mock).reconcileInvoice({
      externalInvoiceID: "invoice-pending",
      expectedAmount: 19_000,
      currency: "MNT",
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      externalInvoiceID: "invoice-pending",
      type: "pending",
      occurredAt: 0,
    })
    expect(mock.calls).toHaveLength(4)
    expect(header(mock.calls[3].init, "authorization")).toBe("Bearer access-token-2")
  })

  test("does not replay invoice creation after an unauthorized mutation response", async () => {
    const mock = mockFetch([{ body: token }, { status: 401, body: { error: "expired" } }])
    const error = await captureError(
      adapter(mock).createInvoice({
        reference: "inv_local_1",
        customerReference: "customer_1",
        description: "MongolGPT Pro багц",
        amount: 39_000,
        currency: "MNT",
      }),
    )

    expect(error).toBeInstanceOf(PaymentProviderResponseError)
    expect(mock.calls).toHaveLength(2)
    expect(mock.pending).toHaveLength(0)
  })

  test("reuses short-lived tokens and parses MNT strings without precision loss", async () => {
    let current = 1_000
    const mock = mockFetch([
      { body: { ...token, expires_in: 10 } },
      {
        body: {
          invoice_id: "invoice-1",
          qr_text: "qpay-qr-1",
          qr_image: "base64-qr-1",
          urls: [],
        },
      },
      {
        body: {
          invoice_id: "invoice-2",
          qr_text: "qpay-qr-2",
          qr_image: "base64-qr-2",
          urls: [],
        },
      },
    ])
    const qpay = new QPayAdapter(
      {
        environment: "sandbox",
        merchantAccountID: "qpay_merchant_test",
        clientID: "client-id",
        clientSecret: "client-secret",
        invoiceCode: "MONGOLGPT_TEST",
        invoiceCallbackURL: "https://dev.mgpt.mn/api/payments/qpay/callback",
      },
      { fetch: mock.fetcher, now: () => current },
    )
    await qpay.createInvoice({
      reference: "inv_local_1",
      customerReference: "customer_1",
      description: "MongolGPT Pro багц",
      amount: 39_000,
      currency: "MNT",
    })
    current += 5_000
    await qpay.createInvoice({
      reference: "inv_local_2",
      customerReference: "customer_1",
      description: "MongolGPT Basic багц",
      amount: 19_000,
      currency: "MNT",
    })

    expect(mock.calls).toHaveLength(3)
    expect(MNTAmountSchema.parse("39000.00")).toBe(39_000)
    expect(MNTAmountSchema.safeParse("39000.0000000000000001").success).toBe(false)
  })

  test("rejects credentials that HTTP Basic authentication cannot encode safely", () => {
    const mock = mockFetch([])
    expect(
      () =>
        new QPayAdapter(
          {
            environment: "sandbox",
            merchantAccountID: "qpay_merchant_test",
            clientID: "client-id",
            clientSecret: "нууц",
            invoiceCode: "MONGOLGPT_TEST",
            invoiceCallbackURL: "https://dev.mgpt.mn/api/payments/qpay/callback",
          },
          { fetch: mock.fetcher },
        ),
    ).toThrow()
    expect(mock.calls).toHaveLength(0)
  })

  test("rejects executable bank deep links from the provider response", async () => {
    const mock = mockFetch([
      { body: token },
      {
        body: {
          invoice_id: "invoice-1",
          qr_text: "qpay-qr",
          qr_image: "base64-qr",
          urls: [{ name: "Хуурамч банк", description: "", link: "javascript:alert(1)" }],
        },
      },
    ])
    const error = await captureError(
      adapter(mock).createInvoice({
        reference: "inv_local_1",
        customerReference: "customer_1",
        description: "MongolGPT Pro багц",
        amount: 39_000,
        currency: "MNT",
      }),
    )

    expect(String(error)).toContain("unsafe protocol")
  })

  test("rejects non-JSON success responses without exposing their body", async () => {
    let bodyCancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("secret upstream page"))
      },
      cancel() {
        bodyCancelled = true
      },
    })
    const mock = mockFetch([{ body: token }, { stream, contentType: "text/html" }])
    const error = await adapter(mock)
      .createInvoice({
        reference: "inv_local_1",
        customerReference: "customer_1",
        description: "MongolGPT Pro багц",
        amount: 39_000,
        currency: "MNT",
      })
      .catch((cause) => cause)
    expect(error).toBeInstanceOf(PaymentProviderResponseError)
    expect(String(error)).not.toContain("secret upstream page")
    expect(bodyCancelled).toBe(true)
  })

  test("rejects oversized provider responses before parsing them", async () => {
    const mock = mockFetch([{ body: token }, { body: {}, contentLength: "2000001" }])
    const error = await captureError(
      adapter(mock).createInvoice({
        reference: "inv_local_1",
        customerReference: "customer_1",
        description: "MongolGPT Pro багц",
        amount: 39_000,
        currency: "MNT",
      }),
    )

    expect(error).toBeInstanceOf(PaymentProviderResponseError)
    expect(String(error)).toContain("HTTP 502")
  })
})
