import {
  MNTAmountSchema,
  PaymentInvoiceCheckoutSchema,
  PaymentInvoiceRequestSchema,
  PaymentProviderResponseError,
  parseVerifiedPaymentEvent,
  readPaymentProviderJSON,
  sha256Hex,
  stableJson,
  type PaymentInvoiceCheckout,
  type PaymentInvoiceRequest,
  type PaymentProviderAdapter,
  type VerifiedPaymentEvent,
} from "../payment-provider"
import { z } from "zod"

const BONUM_BASE_URL = {
  sandbox: "https://testapi.bonum.mn",
  production: "https://apis.bonum.mn",
} as const
const BONUM_CHECKOUT_ORIGIN = "https://ecommerce.bonum.mn"
const MAX_WEBHOOK_BYTES = 1_000_000
const printableASCII = /^[\x20-\x7e]+$/

const BonumConfigSchema = z
  .object({
    environment: z.enum(["sandbox", "production"]),
    merchantAccountID: z.string().trim().min(1).max(255),
    appSecret: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => printableASCII.test(value)),
    terminalID: z
      .string()
      .trim()
      .regex(/^\d{1,32}$/),
    webhookChecksumKey: z.string().min(16).max(4_096),
    invoiceCallbackURL: z
      .url()
      .max(255)
      .refine((value) => new URL(value).protocol === "https:")
      .refine((value) => {
        const url = new URL(value)
        return !url.username && !url.password && !url.search && !url.hash
      }),
    providers: z
      .array(z.enum(["QPAY", "E_COMMERCE", "WE_CHAT", "SONO_SHOP"]))
      .min(1)
      .max(4)
      .refine((values) => new Set(values).size === values.length)
      .default(["E_COMMERCE"]),
    localTimestampOffset: z
      .string()
      .regex(/^[+-](?:0\d|1[0-4]):[0-5]\d$/)
      .default("+08:00"),
    maxExpirySeconds: z.number().int().min(60).max(604_800).default(86_400),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(10_000),
  })
  .strict()

const TokenResponseSchema = z
  .object({
    tokenType: z.literal("Bearer"),
    accessToken: z
      .string()
      .min(1)
      .max(8_192)
      .refine((value) => /^[\x21-\x7e]+$/.test(value)),
    expiresIn: z.number().int().positive(),
    refreshToken: z.string().min(1).max(8_192),
    refreshExpiresIn: z.number().int().positive(),
    unit: z.literal("SECONDS").default("SECONDS"),
  })
  .passthrough()

const InvoiceResponseSchema = z
  .object({
    invoiceId: z.string().trim().min(1).max(255),
    followUpLink: z.url().max(8_192),
  })
  .passthrough()

const SuccessWebhookSchema = z
  .object({
    type: z.literal("PAYMENT"),
    status: z.literal("SUCCESS"),
    message: z.string().max(4_096).default(""),
    body: z
      .object({
        amount: MNTAmountSchema,
        currency: z.literal("MNT"),
        completedAt: z.string().trim().min(1).max(64),
        terminalId: z.string().trim().min(1).max(32),
        invoiceId: z.string().trim().min(1).max(255),
        paymentVendor: z.enum(["QPAY", "E_COMMERCE", "WE_CHAT", "SONO_SHOP"]),
        initType: z.literal("ECOMMERCE"),
        status: z.literal("PAID"),
        transactionId: z.string().trim().min(1).max(45),
      })
      .passthrough(),
  })
  .passthrough()

const FailureWebhookSchema = z
  .object({
    type: z.literal("PAYMENT"),
    status: z.literal("FAILED"),
    message: z.string().max(4_096).default(""),
    body: z
      .object({
        transactionId: z.string().trim().min(1).max(45),
        amount: MNTAmountSchema,
        currency: z.literal("MNT"),
        updatedAt: z.number().int().min(0).max(8_640_000_000_000_000),
        terminalId: z.string().trim().min(1).max(32),
        invoiceId: z.string().trim().min(1).max(255).optional(),
        invoiceStatus: z.enum(["EXPIRED", "CANCELLED", "CANCELED", "FAILED"]),
      })
      .passthrough(),
  })
  .passthrough()

const WebhookSchema = z.discriminatedUnion("status", [SuccessWebhookSchema, FailureWebhookSchema])

const WebhookVerificationInputSchema = z
  .object({
    rawBody: z.string().min(2).max(MAX_WEBHOOK_BYTES),
    checksum: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{64}$/),
    expectedExternalInvoiceID: z.string().trim().min(1).max(255),
    expectedReference: z.string().trim().min(1).max(45),
    expectedAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("MNT"),
    expectedCreatedAt: z.number().int().min(0).max(8_640_000_000_000_000),
  })
  .strict()

type BonumConfig = z.input<typeof BonumConfigSchema>
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type WebhookVerificationInput = z.input<typeof WebhookVerificationInputSchema>

export class BonumWebhookVerificationError extends Error {
  readonly code: "signature" | "payload" | "binding"

  constructor(code: "signature" | "payload" | "binding") {
    super(`Bonum webhook ${code} verification failed`)
    this.name = "BonumWebhookVerificationError"
    this.code = code
  }
}

export class BonumAdapter implements PaymentProviderAdapter {
  readonly provider = "bonum" as const
  readonly merchantAccountID: string
  private readonly config: z.output<typeof BonumConfigSchema>
  private readonly fetcher: Fetch
  private readonly now: () => number
  private token?: {
    value: string
    refreshAt: number
    refreshValue: string
    refreshTokenAt: number
  }
  private tokenRequest?: Promise<string>
  private checksumKey?: Promise<CryptoKey>

  constructor(input: BonumConfig, dependencies: { fetch?: Fetch; now?: () => number } = {}) {
    this.config = BonumConfigSchema.parse(input)
    this.merchantAccountID = this.config.merchantAccountID
    this.fetcher = dependencies.fetch ?? fetch
    this.now = dependencies.now ?? Date.now
  }

  async createInvoice(input: PaymentInvoiceRequest): Promise<PaymentInvoiceCheckout> {
    const invoice = PaymentInvoiceRequestSchema.parse(input)
    const expiresIn = this.expiresIn(invoice.expiresAt)
    const response = InvoiceResponseSchema.parse(
      await this.request("create invoice", "/bonum-gateway/ecommerce/invoices", {
        method: "POST",
        body: JSON.stringify({
          amount: invoice.amount,
          callback: this.config.invoiceCallbackURL,
          transactionId: invoice.reference,
          ...(expiresIn === undefined ? {} : { expiresIn }),
          providers: this.config.providers,
          items: [
            {
              title: invoice.description,
              remark: "MongolGPT",
              amount: invoice.amount,
              count: 1,
            },
          ],
        }),
      }),
    )
    const checkout = new URL(response.followUpLink)
    const checkoutParameters = [...checkout.searchParams.keys()]
    if (
      checkout.origin !== BONUM_CHECKOUT_ORIGIN ||
      checkout.pathname !== "/ecommerce" ||
      checkout.username ||
      checkout.password ||
      checkout.hash ||
      checkout.searchParams.get("invoiceId") !== response.invoiceId ||
      checkoutParameters.length !== 1 ||
      checkoutParameters[0] !== "invoiceId"
    ) {
      throw new PaymentProviderResponseError({
        provider: this.provider,
        operation: "create invoice",
        status: 502,
        retryable: false,
      })
    }
    return PaymentInvoiceCheckoutSchema.parse({
      provider: this.provider,
      merchantAccountID: this.merchantAccountID,
      externalInvoiceID: response.invoiceId,
      checkoutURL: checkout.href,
    })
  }

  async verifyWebhook(input: WebhookVerificationInput): Promise<VerifiedPaymentEvent[]> {
    const request = WebhookVerificationInputSchema.safeParse(input)
    if (!request.success) throw new BonumWebhookVerificationError("payload")
    const rawBytes = new TextEncoder().encode(request.data.rawBody)
    if (rawBytes.byteLength > MAX_WEBHOOK_BYTES) throw new BonumWebhookVerificationError("payload")
    const expectedChecksum = await this.sign(rawBytes)
    if (!constantTimeEqualHex(expectedChecksum, request.data.checksum)) {
      throw new BonumWebhookVerificationError("signature")
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(request.data.rawBody)
    } catch {
      throw new BonumWebhookVerificationError("payload")
    }
    const verified = WebhookSchema.safeParse(parsed)
    if (!verified.success) throw new BonumWebhookVerificationError("payload")

    let terminalID: string
    let externalInvoiceID: string
    let reference: string
    let amount: number
    let currency: "MNT"
    let type: "paid" | "failed" | "expired" | "cancelled"
    let occurredAt: number
    let paymentChannel: string
    let providerStatus: string

    if (verified.data.status === "SUCCESS") {
      const body = verified.data.body
      terminalID = body.terminalId
      externalInvoiceID = body.invoiceId
      reference = body.transactionId
      amount = body.amount
      currency = body.currency
      type = "paid"
      occurredAt = parseLocalTimestamp(body.completedAt, this.config.localTimestampOffset)
      paymentChannel = body.paymentVendor
      providerStatus = body.status
      if (!this.config.providers.includes(body.paymentVendor)) {
        throw new BonumWebhookVerificationError("binding")
      }
    } else {
      const body = verified.data.body
      terminalID = body.terminalId
      externalInvoiceID = body.invoiceId ?? request.data.expectedExternalInvoiceID
      reference = body.transactionId
      amount = body.amount
      currency = body.currency
      paymentChannel = "UNKNOWN"
      providerStatus = body.invoiceStatus
      type =
        body.invoiceStatus === "EXPIRED"
          ? "expired"
          : body.invoiceStatus === "CANCELLED" || body.invoiceStatus === "CANCELED"
            ? "cancelled"
            : "failed"
      occurredAt = body.updatedAt
    }

    if (
      terminalID !== this.config.terminalID ||
      reference !== request.data.expectedReference ||
      externalInvoiceID !== request.data.expectedExternalInvoiceID ||
      amount !== request.data.expectedAmount ||
      currency !== request.data.currency
    ) {
      throw new BonumWebhookVerificationError("binding")
    }
    if (occurredAt < request.data.expectedCreatedAt - 300_000 || occurredAt > this.now() + 300_000) {
      throw new BonumWebhookVerificationError("binding")
    }

    const normalized = {
      terminalID,
      externalInvoiceID,
      reference,
      amount,
      currency,
      type,
      occurredAt,
      paymentChannel,
      providerStatus,
    }
    const payloadHash = await sha256Hex(stableJson(normalized))
    return [
      parseVerifiedPaymentEvent({
        provider: this.provider,
        merchantAccountID: this.merchantAccountID,
        externalEventID: await sha256Hex(`bonum:${terminalID}:${externalInvoiceID}:${reference}:${type}:${occurredAt}`),
        externalInvoiceID,
        ...(type === "paid" ? { externalPaymentID: externalInvoiceID } : {}),
        amount,
        currency,
        type,
        payloadHash,
        occurredAt,
      }),
    ]
  }

  private expiresIn(expiresAt: number | undefined) {
    if (expiresAt === undefined) return undefined
    const seconds = Math.ceil((expiresAt - this.now()) / 1_000)
    if (seconds < 1 || seconds > this.config.maxExpirySeconds) {
      throw new Error("Bonum invoice expiry is outside the configured safety window")
    }
    return seconds
  }

  private async request(operation: string, path: string, init: RequestInit) {
    const token = await this.accessToken()
    const response = await this.fetcher(new URL(path, BONUM_BASE_URL[this.config.environment]), {
      ...init,
      headers: {
        accept: "application/json",
        "accept-language": "mn",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })
    if (response.status === 401 && this.token?.value === token) {
      this.token.refreshAt = 0
    }
    return readPaymentProviderJSON({ provider: this.provider, operation, response })
  }

  private async accessToken() {
    if (this.token && this.token.refreshAt > this.now()) return this.token.value
    if (this.tokenRequest) return this.tokenRequest
    this.tokenRequest = this.obtainToken().finally(() => {
      this.tokenRequest = undefined
    })
    return this.tokenRequest
  }

  private async obtainToken() {
    if (this.token && this.token.refreshTokenAt > this.now()) {
      try {
        return await this.refreshToken(this.token.refreshValue)
      } catch (error) {
        if (error instanceof PaymentProviderResponseError && (error.status === 401 || error.status === 403)) {
          this.token = undefined
          return this.createToken()
        }
        throw error
      }
    }
    this.token = undefined
    return this.createToken()
  }

  private async createToken() {
    const response = await this.fetcher(
      new URL("/bonum-gateway/ecommerce/auth/create", BONUM_BASE_URL[this.config.environment]),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `AppSecret ${this.config.appSecret}`,
          "x-terminal-id": this.config.terminalID,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      },
    )
    return this.cacheToken(
      TokenResponseSchema.parse(
        await readPaymentProviderJSON({ provider: this.provider, operation: "create token", response }),
      ),
    )
  }

  private async refreshToken(refreshToken: string) {
    const response = await this.fetcher(
      new URL("/bonum-gateway/ecommerce/auth/refresh", BONUM_BASE_URL[this.config.environment]),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${refreshToken}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      },
    )
    return this.cacheToken(
      TokenResponseSchema.parse(
        await readPaymentProviderJSON({ provider: this.provider, operation: "refresh token", response }),
      ),
    )
  }

  private cacheToken(token: z.output<typeof TokenResponseSchema>) {
    const current = this.now()
    this.token = {
      value: token.accessToken,
      refreshAt: tokenRefreshAt(current, token.expiresIn * 1_000),
      refreshValue: token.refreshToken,
      refreshTokenAt: tokenRefreshAt(current, token.refreshExpiresIn * 1_000),
    }
    return token.accessToken
  }

  private async sign(rawBody: Uint8Array) {
    this.checksumKey ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.config.webhookChecksumKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const signature = await crypto.subtle.sign("HMAC", await this.checksumKey, rawBody)
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")
  }
}

function tokenRefreshAt(now: number, ttlMs: number) {
  const margin = Math.min(30_000, Math.max(100, Math.floor(ttlMs / 10)))
  return now + ttlMs - margin
}

function parseLocalTimestamp(value: string, offset: string) {
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value)
  const timestamp = local
    ? Date.parse(`${local[1]}-${local[2]}-${local[3]}T${local[4]}:${local[5]}:${local[6]}${offset}`)
    : NaN
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new BonumWebhookVerificationError("payload")
  return timestamp
}

function constantTimeEqualHex(expected: string, received: string) {
  if (expected.length !== received.length) return false
  let difference = 0
  const normalized = received.toLowerCase()
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ normalized.charCodeAt(index)
  }
  return difference === 0
}
