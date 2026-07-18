import { describe, expect, test } from "bun:test"
import { BonumAdapter, BonumWebhookVerificationError } from "../src/payment-provider/bonum"
import { PaymentProviderResponseError } from "../src/payment-provider"

type MockResponse = {
  status?: number
  body?: unknown
  contentType?: string
}

function mockFetch(responses: MockResponse[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error("Unexpected Bonum request")
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "content-type": next.contentType ?? "application/json" },
    })
  }
  return { fetcher, calls, pending: responses }
}

const now = Date.parse("2026-07-19T00:00:00.000Z")
const invoiceCreatedAt = Date.parse("2026-01-29T10:00:00+08:00")
const checksumKey = "bonum-webhook-checksum-test-key"

function adapter(mock: ReturnType<typeof mockFetch>) {
  return new BonumAdapter(
    {
      environment: "sandbox",
      merchantAccountID: "bonum_terminal_17171994",
      appSecret: "app-secret",
      terminalID: "17171994",
      webhookChecksumKey: checksumKey,
      invoiceCallbackURL: "https://dev.mgpt.mn/api/payments/bonum/callback",
      providers: ["E_COMMERCE"],
    },
    { fetch: mock.fetcher, now: () => now },
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

async function sign(rawBody: string, secret = checksumKey) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const token = {
  tokenType: "Bearer",
  accessToken: "access-token",
  expiresIn: 1_800,
  refreshToken: "refresh-token",
  refreshExpiresIn: 2_000,
  unit: "SECONDS",
}

const successPayload = {
  type: "PAYMENT",
  status: "SUCCESS",
  message: "",
  body: {
    amount: 39_000,
    currency: "MNT",
    completedAt: "2026-01-29 11:20:33",
    terminalId: "17171994",
    invoiceId: "bonum-invoice-1",
    paymentVendor: "E_COMMERCE",
    initType: "ECOMMERCE",
    status: "PAID",
    respCode: "",
    transactionId: "inv_local_1",
    extras: [],
  },
}

function verification(rawBody: string, checksum: string) {
  return {
    rawBody,
    checksum,
    expectedExternalInvoiceID: "bonum-invoice-1",
    expectedReference: "inv_local_1",
    expectedAmount: 39_000,
    currency: "MNT" as const,
    expectedCreatedAt: invoiceCreatedAt,
  }
}

describe("Bonum Ecommerce Gateway adapter", () => {
  test("creates a sandbox invoice with a cached terminal token", async () => {
    const mock = mockFetch([
      { body: token },
      {
        body: {
          invoiceId: "bonum-invoice-1",
          followUpLink: "https://ecommerce.bonum.mn/ecommerce?invoiceId=bonum-invoice-1",
        },
      },
      {
        body: {
          invoiceId: "bonum-invoice-2",
          followUpLink: "https://ecommerce.bonum.mn/ecommerce?invoiceId=bonum-invoice-2",
        },
      },
    ])
    const bonum = adapter(mock)
    const first = await bonum.createInvoice({
      reference: "inv_local_1",
      customerReference: "customer_1",
      description: "MongolGPT Pro багц",
      amount: 39_000,
      currency: "MNT",
      expiresAt: now + 23_000_000,
    })
    const second = await bonum.createInvoice({
      reference: "inv_local_2",
      customerReference: "customer_1",
      description: "MongolGPT Basic багц",
      amount: 19_000,
      currency: "MNT",
    })

    expect(first).toEqual({
      provider: "bonum",
      merchantAccountID: "bonum_terminal_17171994",
      externalInvoiceID: "bonum-invoice-1",
      checkoutURL: "https://ecommerce.bonum.mn/ecommerce?invoiceId=bonum-invoice-1",
      deepLinks: [],
    })
    expect(second.externalInvoiceID).toBe("bonum-invoice-2")
    expect(mock.calls).toHaveLength(3)
    expect(mock.calls[0]?.url).toBe("https://testapi.bonum.mn/bonum-gateway/ecommerce/auth/create")
    expect(mock.calls[0]?.init.method).toBe("GET")
    expect(header(mock.calls[0].init, "authorization")).toBe("AppSecret app-secret")
    expect(header(mock.calls[0].init, "x-terminal-id")).toBe("17171994")
    expect(mock.calls[1]?.url).toBe("https://testapi.bonum.mn/bonum-gateway/ecommerce/invoices")
    expect(header(mock.calls[1].init, "authorization")).toBe("Bearer access-token")
    expect(header(mock.calls[1].init, "accept-language")).toBe("mn")
    expect(body(mock.calls[1].init)).toEqual({
      amount: 39_000,
      callback: "https://dev.mgpt.mn/api/payments/bonum/callback",
      transactionId: "inv_local_1",
      expiresIn: 23_000,
      providers: ["E_COMMERCE"],
      items: [
        {
          title: "MongolGPT Pro багц",
          remark: "MongolGPT",
          amount: 39_000,
          count: 1,
        },
      ],
    })
    expect(mock.pending).toHaveLength(0)
  })

  test("does not retry invoice creation after an unauthorized response", async () => {
    const refreshedToken = {
      ...token,
      accessToken: "access-token-2",
      refreshToken: "refresh-token-2",
    }
    const mock = mockFetch([
      { body: token },
      { status: 401, body: { message: "expired" } },
      { body: refreshedToken },
      {
        body: {
          invoiceId: "bonum-invoice-1",
          followUpLink: "https://ecommerce.bonum.mn/ecommerce?invoiceId=bonum-invoice-1",
        },
      },
    ])
    const bonum = adapter(mock)
    const error = await captureError(
      bonum.createInvoice({
        reference: "inv_local_1",
        customerReference: "customer_1",
        description: "MongolGPT Pro багц",
        amount: 39_000,
        currency: "MNT",
      }),
    )

    expect(error).toBeInstanceOf(PaymentProviderResponseError)
    expect(mock.calls).toHaveLength(2)

    const checkout = await bonum.createInvoice({
      reference: "inv_local_1",
      customerReference: "customer_1",
      description: "MongolGPT Pro багц",
      amount: 39_000,
      currency: "MNT",
    })
    expect(checkout.externalInvoiceID).toBe("bonum-invoice-1")
    expect(mock.calls).toHaveLength(4)
    expect(mock.calls[2]?.url).toBe("https://testapi.bonum.mn/bonum-gateway/ecommerce/auth/refresh")
    expect(header(mock.calls[2].init, "authorization")).toBe("Bearer refresh-token")
    expect(header(mock.calls[3].init, "authorization")).toBe("Bearer access-token-2")
  })

  test("reuses short-lived tokens until their bounded refresh margin", async () => {
    let current = now
    const mock = mockFetch([
      { body: { ...token, expiresIn: 10 } },
      {
        body: {
          invoiceId: "bonum-invoice-1",
          followUpLink: "https://ecommerce.bonum.mn/ecommerce?invoiceId=bonum-invoice-1",
        },
      },
      {
        body: {
          invoiceId: "bonum-invoice-2",
          followUpLink: "https://ecommerce.bonum.mn/ecommerce?invoiceId=bonum-invoice-2",
        },
      },
    ])
    const bonum = new BonumAdapter(
      {
        environment: "sandbox",
        merchantAccountID: "bonum_terminal_17171994",
        appSecret: "app-secret",
        terminalID: "17171994",
        webhookChecksumKey: checksumKey,
        invoiceCallbackURL: "https://dev.mgpt.mn/api/payments/bonum/callback",
        providers: ["E_COMMERCE"],
      },
      { fetch: mock.fetcher, now: () => current },
    )
    await bonum.createInvoice({
      reference: "inv_local_1",
      customerReference: "customer_1",
      description: "MongolGPT Pro багц",
      amount: 39_000,
      currency: "MNT",
    })
    current += 5_000
    await bonum.createInvoice({
      reference: "inv_local_2",
      customerReference: "customer_1",
      description: "MongolGPT Basic багц",
      amount: 19_000,
      currency: "MNT",
    })

    expect(mock.calls).toHaveLength(3)
    expect(mock.calls.filter((call) => call.url.endsWith("/auth/create"))).toHaveLength(1)
  })

  test("rejects unsafe checkout origins and invoice expiry windows before fulfillment", async () => {
    for (const followUpLink of [
      "https://attacker.example/ecommerce?invoiceId=bonum-invoice-1",
      "https://ecommerce.bonum.mn/other?invoiceId=bonum-invoice-1",
      "https://ecommerce.bonum.mn/ecommerce?invoiceId=other-invoice",
      "https://ecommerce.bonum.mn/ecommerce?invoiceId=bonum-invoice-1&redirect=https://attacker.example",
    ]) {
      const unsafe = mockFetch([{ body: token }, { body: { invoiceId: "bonum-invoice-1", followUpLink } }])
      const error = await captureError(
        adapter(unsafe).createInvoice({
          reference: "inv_local_1",
          customerReference: "customer_1",
          description: "MongolGPT Pro багц",
          amount: 39_000,
          currency: "MNT",
        }),
      )
      expect(error).toBeInstanceOf(PaymentProviderResponseError)
    }

    const expiry = mockFetch([])
    const expiryError = await captureError(
      adapter(expiry).createInvoice({
        reference: "inv_local_1",
        customerReference: "customer_1",
        description: "MongolGPT Pro багц",
        amount: 39_000,
        currency: "MNT",
        expiresAt: now + 86_401_000,
      }),
    )
    expect(String(expiryError)).toContain("outside the configured safety window")
    expect(expiry.calls).toHaveLength(0)
  })

  test("verifies a paid webhook over its exact raw body and produces a deterministic event", async () => {
    const rawBody = JSON.stringify(successPayload)
    const checksum = await sign(rawBody)
    const bonum = adapter(mockFetch([]))
    const first = await bonum.verifyWebhook(verification(rawBody, checksum))
    const replay = await bonum.verifyWebhook(verification(rawBody, checksum))

    expect(first).toEqual(replay)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      provider: "bonum",
      merchantAccountID: "bonum_terminal_17171994",
      externalInvoiceID: "bonum-invoice-1",
      externalPaymentID: "bonum-invoice-1",
      amount: 39_000,
      currency: "MNT",
      type: "paid",
      occurredAt: Date.parse("2026-01-29T11:20:33+08:00"),
    })
    expect(first[0]?.externalEventID).toHaveLength(64)
    expect(first[0]?.payloadHash).toHaveLength(64)
  })

  test("rejects altered raw bodies before parsing or applying them", async () => {
    const rawBody = JSON.stringify(successPayload)
    const checksum = await sign(rawBody)
    const altered = rawBody.replace("39000", "39001")
    const error = await captureError(adapter(mockFetch([])).verifyWebhook(verification(altered, checksum)))

    expect(error).toBeInstanceOf(BonumWebhookVerificationError)
    expect(error).toMatchObject({ code: "signature" })
  })

  test("binds signed webhooks to the configured terminal, invoice, reference, amount, and currency", async () => {
    const cases = [
      {
        payload: { ...successPayload, body: { ...successPayload.body, terminalId: "99999999" } },
        expected: {},
      },
      {
        payload: { ...successPayload, body: { ...successPayload.body, invoiceId: "other-invoice" } },
        expected: {},
      },
      {
        payload: { ...successPayload, body: { ...successPayload.body, transactionId: "other-reference" } },
        expected: {},
      },
      {
        payload: { ...successPayload, body: { ...successPayload.body, paymentVendor: "QPAY" } },
        expected: {},
      },
      {
        payload: { ...successPayload, body: { ...successPayload.body, completedAt: "2020-01-01 00:00:00" } },
        expected: {},
      },
      {
        payload: { ...successPayload, body: { ...successPayload.body, completedAt: "2027-01-01 00:00:00" } },
        expected: {},
      },
      {
        payload: successPayload,
        expected: { expectedAmount: 59_000 },
      },
    ]

    for (const item of cases) {
      const rawBody = JSON.stringify(item.payload)
      const checksum = await sign(rawBody)
      const error = await captureError(
        adapter(mockFetch([])).verifyWebhook({
          ...verification(rawBody, checksum),
          ...item.expected,
        }),
      )
      expect(error).toBeInstanceOf(BonumWebhookVerificationError)
      expect(error).toMatchObject({ code: "binding" })
    }

    const wrongCurrency = JSON.stringify({
      ...successPayload,
      body: { ...successPayload.body, currency: "USD" },
    })
    const currencyError = await captureError(
      adapter(mockFetch([])).verifyWebhook(verification(wrongCurrency, await sign(wrongCurrency))),
    )
    expect(currencyError).toMatchObject({ code: "payload" })
  })

  test("maps a signed failed expiry webhook to an expired ledger event", async () => {
    const payload = {
      type: "PAYMENT",
      status: "FAILED",
      message: "",
      body: {
        transactionId: "inv_local_1",
        amount: 39_000,
        currency: "MNT",
        updatedAt: 1_769_657_291_559,
        terminalId: "17171994",
        invoiceStatus: "EXPIRED",
      },
    }
    const rawBody = JSON.stringify(payload)
    const events = await adapter(mockFetch([])).verifyWebhook(verification(rawBody, await sign(rawBody)))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      externalInvoiceID: "bonum-invoice-1",
      amount: 39_000,
      currency: "MNT",
      type: "expired",
      occurredAt: 1_769_657_291_559,
    })
    expect(events[0]?.externalPaymentID).toBeUndefined()
  })

  test("rejects callback endpoint configuration containing query data", () => {
    const mock = mockFetch([])
    expect(
      () =>
        new BonumAdapter(
          {
            environment: "sandbox",
            merchantAccountID: "bonum_terminal_17171994",
            appSecret: "app-secret",
            terminalID: "17171994",
            webhookChecksumKey: checksumKey,
            invoiceCallbackURL: "https://dev.mgpt.mn/api/payments/bonum/callback?invoice=caller",
          },
          { fetch: mock.fetcher },
        ),
    ).toThrow()
    expect(mock.calls).toHaveLength(0)
  })
})
