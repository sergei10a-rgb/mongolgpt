import {
  PaymentInvoiceCheckoutSchema,
  PaymentInvoiceRequestSchema,
  PaymentProviderResponseError,
  PaymentReconciliationRequestSchema,
  parseVerifiedPaymentEvent,
  sha256Hex,
  stableJson,
  type PaymentInvoiceCheckout,
  type PaymentInvoiceRequest,
  type PaymentProviderAdapter,
  type PaymentReconciliationRequest,
  type VerifiedPaymentEvent,
} from "../payment-provider"
import { z } from "zod"

const QPAY_BASE_URL = {
  sandbox: "https://merchant-sandbox.qpay.mn",
  production: "https://merchant.qpay.mn",
} as const
const MAX_RESPONSE_BYTES = 2_000_000
const printableASCII = /^[\x20-\x7e]+$/

const money = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d+)?$/),
  ])
  .transform((value, context) => {
    const amount = typeof value === "number" ? value : Number(value)
    if (!Number.isSafeInteger(amount) || amount < 0) {
      context.addIssue({ code: "custom", message: "QPay returned an invalid MNT amount" })
      return z.NEVER
    }
    return amount
  })

const QPayConfigSchema = z
  .object({
    environment: z.enum(["sandbox", "production"]),
    merchantAccountID: z.string().trim().min(1).max(255),
    clientID: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !value.includes(":") && printableASCII.test(value)),
    clientSecret: z
      .string()
      .min(1)
      .max(2_048)
      .refine((value) => printableASCII.test(value)),
    invoiceCode: z.string().trim().min(1).max(45),
    invoiceCallbackURL: z
      .url()
      .max(255)
      .refine((value) => new URL(value).protocol === "https:")
      .refine((value) => {
        const url = new URL(value)
        return !url.username && !url.password && !url.search && !url.hash
      }),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(10_000),
  })
  .strict()

const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    token_type: z.string().min(1).optional(),
    expires_in: z.number().int().positive(),
  })
  .passthrough()

const InvoiceResponseSchema = z
  .object({
    invoice_id: z.string().trim().min(1).max(255),
    qr_text: z.string().max(32_768),
    qr_image: z.string().max(2_000_000),
    urls: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(255),
            description: z.string().trim().max(255).default(""),
            link: z.string().trim().min(1).max(8_192),
          })
          .passthrough(),
      )
      .max(64),
  })
  .passthrough()

const PaymentRowSchema = z
  .object({
    payment_id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().trim().min(1).max(255)),
    payment_status: z.enum(["NEW", "FAILED", "PAID", "REFUNDED"]),
    payment_date: z.iso.datetime({ offset: true }),
    payment_amount: money,
    payment_currency: z.literal("MNT"),
  })
  .passthrough()

const PaymentCheckResponseSchema = z
  .object({
    count: z.number().int().min(0).max(100),
    paid_amount: money,
    rows: z.array(PaymentRowSchema).max(100),
  })
  .passthrough()
  .superRefine((input, context) => {
    if (input.count !== input.rows.length) {
      context.addIssue({ code: "custom", message: "QPay returned an incomplete payment page" })
    }
  })

const QPayCallbackHintSchema = z
  .object({
    paymentID: z.string().trim().min(1).max(255).optional(),
  })
  .strict()

type QPayConfig = z.input<typeof QPayConfigSchema>
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class QPayAdapter implements PaymentProviderAdapter {
  readonly provider = "qpay" as const
  readonly merchantAccountID: string
  private readonly config: z.output<typeof QPayConfigSchema>
  private readonly fetcher: Fetch
  private readonly now: () => number
  private token?: { value: string; expiresAt: number }
  private tokenRequest?: Promise<string>

  constructor(input: QPayConfig, dependencies: { fetch?: Fetch; now?: () => number } = {}) {
    this.config = QPayConfigSchema.parse(input)
    this.merchantAccountID = this.config.merchantAccountID
    this.fetcher = dependencies.fetch ?? fetch
    this.now = dependencies.now ?? Date.now
  }

  async createInvoice(input: PaymentInvoiceRequest): Promise<PaymentInvoiceCheckout> {
    const invoice = PaymentInvoiceRequestSchema.parse(input)
    const callback = new URL(this.config.invoiceCallbackURL)
    callback.searchParams.set("invoice", invoice.reference)
    const response = InvoiceResponseSchema.parse(
      await this.request("create invoice", "/v2/invoice", {
        method: "POST",
        body: JSON.stringify({
          invoice_code: this.config.invoiceCode,
          sender_invoice_no: invoice.reference,
          invoice_receiver_code: invoice.customerReference,
          invoice_description: invoice.description,
          amount: invoice.amount,
          callback_url: callback.href,
          allow_partial: false,
          allow_exceed: false,
          ...(invoice.expiresAt === undefined
            ? {}
            : {
                enable_expiry: true,
                expiry_date: new Date(invoice.expiresAt).toISOString(),
              }),
        }),
      }),
    )
    return PaymentInvoiceCheckoutSchema.parse({
      provider: this.provider,
      merchantAccountID: this.merchantAccountID,
      externalInvoiceID: response.invoice_id,
      qrText: response.qr_text,
      qrImage: response.qr_image,
      deepLinks: response.urls,
    })
  }

  async reconcileInvoice(input: PaymentReconciliationRequest): Promise<VerifiedPaymentEvent[]> {
    const request = PaymentReconciliationRequestSchema.parse(input)
    const response = PaymentCheckResponseSchema.parse(
      await this.request(
        "check payment",
        "/v2/payment/check",
        {
          method: "POST",
          body: JSON.stringify({
            object_type: "INVOICE",
            object_id: request.externalInvoiceID,
            offset: { page_number: 1, page_limit: 100 },
          }),
        },
        true,
      ),
    )
    if (request.callbackPaymentID && !response.rows.some((row) => row.payment_id === request.callbackPaymentID)) {
      throw new Error("QPay callback payment was not present in the verified invoice")
    }

    const settled = response.rows.filter((row) => row.payment_status === "PAID" || row.payment_status === "REFUNDED")
    if (settled.length > 1) throw new Error("QPay invoice has ambiguous settled payments")

    const row = settled[0]
    if (!row) return [await this.pendingEvent(request, response)]
    if (request.callbackPaymentID && row.payment_id !== request.callbackPaymentID) {
      throw new Error("QPay callback payment does not match the verified settled payment")
    }
    if (row.payment_amount !== request.expectedAmount || row.payment_currency !== request.currency) {
      throw new Error("QPay verified payment amount or currency does not match the invoice")
    }

    const occurredAt = Date.parse(row.payment_date)
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new Error("QPay returned an invalid payment date")
    const payloadHash = await sha256Hex(stableJson(row))
    const paid = parseVerifiedPaymentEvent({
      provider: this.provider,
      merchantAccountID: this.merchantAccountID,
      externalEventID: await sha256Hex(`qpay:${row.payment_id}:paid`),
      externalInvoiceID: request.externalInvoiceID,
      externalPaymentID: row.payment_id,
      amount: row.payment_amount,
      currency: row.payment_currency,
      type: "paid",
      payloadHash,
      occurredAt,
    })
    if (row.payment_status === "PAID") return [paid]
    return [
      paid,
      parseVerifiedPaymentEvent({
        ...paid,
        externalEventID: await sha256Hex(`qpay:${row.payment_id}:refunded`),
        type: "refunded",
      }),
    ]
  }

  static callbackHint(input: unknown) {
    if (input instanceof URL) {
      return QPayCallbackHintSchema.parse({
        paymentID: input.searchParams.get("payment_id") ?? undefined,
      })
    }
    if (!input || typeof input !== "object") return QPayCallbackHintSchema.parse({})
    const paymentID = Reflect.get(input, "paymentID")
    const paymentIDSnake = Reflect.get(input, "payment_id")
    return QPayCallbackHintSchema.parse({
      paymentID:
        typeof paymentIDSnake === "string" ? paymentIDSnake : typeof paymentID === "string" ? paymentID : undefined,
    })
  }

  private async pendingEvent(
    request: z.output<typeof PaymentReconciliationRequestSchema>,
    response: z.output<typeof PaymentCheckResponseSchema>,
  ) {
    const payloadHash = await sha256Hex(stableJson(response))
    const latest = response.rows.reduce((time, row) => Math.max(time, Date.parse(row.payment_date)), 0)
    return parseVerifiedPaymentEvent({
      provider: this.provider,
      merchantAccountID: this.merchantAccountID,
      externalEventID: await sha256Hex(`qpay:${request.externalInvoiceID}:pending:${payloadHash}`),
      externalInvoiceID: request.externalInvoiceID,
      type: "pending",
      payloadHash,
      occurredAt: Number.isSafeInteger(latest) && latest >= 0 ? latest : 0,
    })
  }

  private async request(
    operation: string,
    path: string,
    init: RequestInit,
    retryUnauthorized = false,
  ): Promise<unknown> {
    const token = await this.accessToken()
    const response = await this.fetcher(new URL(path, QPAY_BASE_URL[this.config.environment]), {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })
    if (response.status === 401 && retryUnauthorized) {
      if (this.token?.value === token) this.token = undefined
      await cancelBody(response)
      return this.request(operation, path, init, false)
    }
    return readResponse(this.provider, operation, response)
  }

  private async accessToken() {
    if (this.token && this.token.expiresAt - 30_000 > this.now()) return this.token.value
    if (this.tokenRequest) return this.tokenRequest
    this.tokenRequest = this.createToken().finally(() => {
      this.tokenRequest = undefined
    })
    return this.tokenRequest
  }

  private async createToken() {
    const authorization = btoa(`${this.config.clientID}:${this.config.clientSecret}`)
    const response = await this.fetcher(new URL("/v2/auth/token", QPAY_BASE_URL[this.config.environment]), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Basic ${authorization}`,
      },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })
    const token = TokenResponseSchema.parse(await readResponse(this.provider, "create token", response))
    this.token = {
      value: token.access_token,
      expiresAt: this.now() + token.expires_in * 1_000,
    }
    return token.access_token
  }
}

async function readResponse(provider: "qpay", operation: string, response: Response) {
  if (!response.ok) {
    await cancelBody(response)
    throw new PaymentProviderResponseError({
      provider,
      operation,
      status: response.status,
    })
  }
  if (response.status === 204) return undefined
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/json")) {
    await cancelBody(response)
    throw invalidResponse(provider, operation)
  }
  const body = await readLimitedBody(provider, operation, response)
  try {
    return JSON.parse(body)
  } catch {
    throw invalidResponse(provider, operation)
  }
}

async function readLimitedBody(provider: "qpay", operation: string, response: Response) {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const bytes = Number(declared)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESPONSE_BYTES) {
      await cancelBody(response)
      throw invalidResponse(provider, operation)
    }
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ""
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw invalidResponse(provider, operation)
      }
      body += decoder.decode(part.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function invalidResponse(provider: "qpay", operation: string) {
  return new PaymentProviderResponseError({ provider, operation, status: 502, retryable: false })
}

async function cancelBody(response: Response) {
  if (!response.body) return
  await response.body.cancel().catch(() => undefined)
}
