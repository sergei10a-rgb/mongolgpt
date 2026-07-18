import { ApplyPaymentEventSchema, type ApplyPaymentEventInput } from "./payment-ledger"
import { PaymentProviders } from "./schema/billing.sql"
import { z } from "zod"

const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000

const httpsURL = z
  .url()
  .max(255)
  .refine((value) => new URL(value).protocol === "https:", "Payment checkout URL must use HTTPS")

const paymentDeepLink = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol.toLowerCase()
    return !["javascript:", "data:", "vbscript:", "file:", "blob:"].includes(protocol)
  }, "Payment deep link uses an unsafe protocol")

export const PaymentInvoiceRequestSchema = z
  .object({
    reference: z.string().trim().min(1).max(45),
    customerReference: z.string().trim().min(1).max(45),
    description: z.string().trim().min(1).max(255),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("MNT"),
    expiresAt: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
  })
  .strict()

export const PaymentDeepLinkSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(255).default(""),
    link: paymentDeepLink,
  })
  .strict()

export const PaymentInvoiceCheckoutSchema = z
  .object({
    provider: z.enum(PaymentProviders),
    merchantAccountID: z.string().trim().min(1).max(255),
    externalInvoiceID: z.string().trim().min(1).max(255),
    qrText: z.string().max(32_768).optional(),
    qrImage: z.string().max(2_000_000).optional(),
    checkoutURL: httpsURL.optional(),
    deepLinks: z.array(PaymentDeepLinkSchema).max(64).default([]),
  })
  .strict()

export const PaymentReconciliationRequestSchema = z
  .object({
    externalInvoiceID: z.string().trim().min(1).max(255),
    expectedAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("MNT"),
    callbackPaymentID: z.string().trim().min(1).max(255).optional(),
  })
  .strict()

export const MNTAmountSchema = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^\d+(?:\.0+)?$/),
  ])
  .transform((value, context) => {
    const amount = typeof value === "number" ? value : Number(value.split(".", 1)[0])
    if (!Number.isSafeInteger(amount) || amount < 0) {
      context.addIssue({ code: "custom", message: "Payment provider returned an invalid MNT amount" })
      return z.NEVER
    }
    return amount
  })

export type PaymentInvoiceRequest = z.input<typeof PaymentInvoiceRequestSchema>
export type PaymentInvoiceCheckout = z.output<typeof PaymentInvoiceCheckoutSchema>
export type PaymentReconciliationRequest = z.input<typeof PaymentReconciliationRequestSchema>
export type VerifiedPaymentEvent = ApplyPaymentEventInput

export interface PaymentProviderAdapter {
  readonly provider: (typeof PaymentProviders)[number]
  readonly merchantAccountID: string
  createInvoice(input: PaymentInvoiceRequest): Promise<PaymentInvoiceCheckout>
}

export interface PaymentReconciliationAdapter extends PaymentProviderAdapter {
  reconcileInvoice(input: PaymentReconciliationRequest): Promise<VerifiedPaymentEvent[]>
}

export class PaymentProviderResponseError extends Error {
  readonly provider: (typeof PaymentProviders)[number]
  readonly operation: string
  readonly status: number
  readonly retryable: boolean

  constructor(input: {
    provider: (typeof PaymentProviders)[number]
    operation: string
    status: number
    retryable?: boolean
  }) {
    super(`${input.provider} ${input.operation} failed with HTTP ${input.status}`)
    this.name = "PaymentProviderResponseError"
    this.provider = input.provider
    this.operation = input.operation
    this.status = input.status
    this.retryable = input.retryable ?? (input.status === 429 || input.status >= 500)
  }
}

export function parseVerifiedPaymentEvent(input: ApplyPaymentEventInput) {
  return ApplyPaymentEventSchema.parse(input)
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function readPaymentProviderJSON(input: {
  provider: (typeof PaymentProviders)[number]
  operation: string
  response: Response
  maxBytes?: number
}) {
  const maxBytes = input.maxBytes ?? MAX_PROVIDER_RESPONSE_BYTES
  if (!input.response.ok) {
    await cancelPaymentProviderResponse(input.response)
    throw new PaymentProviderResponseError({
      provider: input.provider,
      operation: input.operation,
      status: input.response.status,
    })
  }
  if (input.response.status === 204) return undefined
  const contentType = input.response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/json")) {
    await cancelPaymentProviderResponse(input.response)
    throw invalidProviderResponse(input.provider, input.operation)
  }
  const body = await readLimitedBody(input.provider, input.operation, input.response, maxBytes)
  try {
    return JSON.parse(body)
  } catch {
    throw invalidProviderResponse(input.provider, input.operation)
  }
}

export async function cancelPaymentProviderResponse(response: Response) {
  if (!response.body) return
  await response.body.cancel().catch(() => undefined)
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError("Payment provider payload is not JSON serializable")
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(Reflect.get(value, key))}`)
    .join(",")}}`
}

async function readLimitedBody(
  provider: (typeof PaymentProviders)[number],
  operation: string,
  response: Response,
  maxBytes: number,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("Payment response limit is invalid")
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const bytes = Number(declared)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) {
      await cancelPaymentProviderResponse(response)
      throw invalidProviderResponse(provider, operation)
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
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw invalidProviderResponse(provider, operation)
      }
      body += decoder.decode(part.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function invalidProviderResponse(provider: (typeof PaymentProviders)[number], operation: string) {
  return new PaymentProviderResponseError({ provider, operation, status: 502, retryable: false })
}
