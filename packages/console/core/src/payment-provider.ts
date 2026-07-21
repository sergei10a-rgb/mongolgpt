import { ApplyPaymentEventSchema, type ApplyPaymentEventInput } from "./payment-ledger"
import { PaymentProviders } from "./schema/billing.sql"
import type {
  PaymentInvoiceCancellationReceipt,
  PaymentInvoiceCancellationRequest,
  PaymentInvoiceCheckout,
  PaymentInvoiceRequest,
  PaymentReconciliationRequest,
} from "./payment-provider-contract"

export {
  MNTAmountSchema,
  PaymentDeepLinkSchema,
  PaymentInvoiceCheckoutSchema,
  PaymentInvoiceCancellationReceiptSchema,
  PaymentInvoiceCancellationRequestSchema,
  PaymentInvoiceRequestSchema,
  PaymentReconciliationRequestSchema,
  type PaymentInvoiceCheckout,
  type PaymentInvoiceCancellationReceipt,
  type PaymentInvoiceCancellationRequest,
  type PaymentInvoiceRequest,
  type PaymentReconciliationRequest,
} from "./payment-provider-contract"

const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000
export type VerifiedPaymentEvent = ApplyPaymentEventInput

export interface PaymentProviderAdapter {
  readonly provider: (typeof PaymentProviders)[number]
  readonly merchantAccountID: string
  createInvoice(input: PaymentInvoiceRequest): Promise<PaymentInvoiceCheckout>
}

export interface PaymentReconciliationAdapter extends PaymentProviderAdapter {
  reconcileInvoice(input: PaymentReconciliationRequest): Promise<VerifiedPaymentEvent[]>
}

export interface PaymentCancellationAdapter extends PaymentProviderAdapter {
  cancelInvoice(input: PaymentInvoiceCancellationRequest): Promise<PaymentInvoiceCancellationReceipt>
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
