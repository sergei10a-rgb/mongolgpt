import { Resource } from "@mongolgpt/console-resource"
import { createPaymentQueueEvent, type PaymentQueueEvent } from "@mongolgpt/console-core/payment-queue.js"
import {
  PaymentInvoiceReferenceSchema,
  PaymentIngressNotFoundError,
  reconcileQPayCallback,
  verifyBonumWebhook,
} from "@mongolgpt/console-core/payment-ingress.js"
import { BonumAdapter, BonumWebhookVerificationError } from "@mongolgpt/console-core/payment-provider/bonum.js"
import { QPayAdapter } from "@mongolgpt/console-core/payment-provider/qpay.js"
import { PaymentProviderResponseError, type VerifiedPaymentEvent } from "@mongolgpt/console-core/payment-provider.js"
import { z } from "zod"

const MAX_WEBHOOK_BYTES = 1_000_000

type Dependencies = {
  qpay?: (input: { reference: string; callbackPaymentID?: string }) => Promise<VerifiedPaymentEvent[]>
  bonum?: (input: { rawBody: string; checksum: string }) => Promise<VerifiedPaymentEvent[]>
  enqueue(events: PaymentQueueEvent[]): Promise<void>
}

class PaymentQueueUnavailableError extends Error {
  constructor() {
    super("Payment queue unavailable")
    this.name = "PaymentQueueUnavailableError"
  }
}

class InvalidPaymentWebhookRequestError extends Error {
  constructor() {
    super("Invalid payment webhook request")
    this.name = "InvalidPaymentWebhookRequestError"
  }
}

function text(body: string, status = 200, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers)
  responseHeaders.set("Cache-Control", "no-store")
  responseHeaders.set("Content-Type", "text/plain; charset=utf-8")
  return new Response(body, {
    status,
    headers: responseHeaders,
  })
}

async function enqueueVerifiedEvents(events: VerifiedPaymentEvent[], dependencies: Dependencies) {
  if (events.length < 1 || events.length > 2) throw new Error("Payment verifier returned an invalid event count")
  try {
    await dependencies.enqueue(events.map((event) => createPaymentQueueEvent(event)))
  } catch {
    throw new PaymentQueueUnavailableError()
  }
}

function uniqueQueryValue(url: URL, name: string, required: boolean) {
  const values = url.searchParams.getAll(name)
  if (values.length > 1 || (required && values.length !== 1)) throw new InvalidPaymentWebhookRequestError()
  const value = values[0]?.trim()
  if (required && !value) throw new InvalidPaymentWebhookRequestError()
  return value || undefined
}

async function readBoundedBody(request: Request) {
  const declared = request.headers.get("content-length")
  if (declared !== null) {
    const bytes = Number(declared)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_WEBHOOK_BYTES) {
      await request.body?.cancel().catch(() => undefined)
      throw new RangeError("Webhook body is too large")
    }
  }
  if (!request.body) return ""

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ""
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RangeError("Webhook body is too large")
      }
      body += decoder.decode(part.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export function createPaymentWebhookHandler(dependencies: Dependencies) {
  return async function handle(request: Request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/health") {
        return Response.json(
          {
            status: dependencies.qpay || dependencies.bonum ? "ok" : "disabled",
            service: "payments",
            providers: {
              qpay: Boolean(dependencies.qpay),
              bonum: Boolean(dependencies.bonum),
            },
          },
          { headers: { "Cache-Control": "no-store" } },
        )
      }

      if (url.pathname === "/v1/webhooks/qpay") {
        if (request.method !== "GET" && request.method !== "POST") {
          return text("METHOD_NOT_ALLOWED", 405, { Allow: "GET, POST" })
        }
        if (!dependencies.qpay) return text("PAYMENTS_NOT_CONFIGURED", 503)
        await request.body?.cancel().catch(() => undefined)
        const events = await dependencies.qpay({
          reference: PaymentInvoiceReferenceSchema.parse(uniqueQueryValue(url, "invoice", true)),
          callbackPaymentID: uniqueQueryValue(url, "payment_id", false),
        })
        await enqueueVerifiedEvents(events, dependencies)
        return text("SUCCESS")
      }

      if (url.pathname === "/v1/webhooks/bonum") {
        if (request.method !== "POST") return text("METHOD_NOT_ALLOWED", 405, { Allow: "POST" })
        if (!dependencies.bonum) return text("PAYMENTS_NOT_CONFIGURED", 503)
        const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
        if (!contentType.includes("application/json")) return text("INVALID_REQUEST", 400)
        const checksum = request.headers.get("x-checksum-v2") ?? ""
        const events = await dependencies.bonum({
          rawBody: await readBoundedBody(request),
          checksum,
        })
        await enqueueVerifiedEvents(events, dependencies)
        return text("SUCCESS")
      }

      return text("NOT_FOUND", 404)
    } catch (error) {
      console.error("Payment webhook request failed", {
        path: url.pathname,
        ray: request.headers.get("cf-ray") ?? "unknown",
        error: error instanceof Error ? error.name : typeof error,
      })
      if (error instanceof PaymentQueueUnavailableError) return text("TRY_AGAIN", 503)
      if (error instanceof PaymentIngressNotFoundError) return text("NOT_FOUND", 404)
      if (error instanceof BonumWebhookVerificationError) {
        return text("INVALID_WEBHOOK", error.code === "signature" ? 401 : 400)
      }
      if (error instanceof PaymentProviderResponseError) return text("TRY_AGAIN", error.retryable ? 503 : 502)
      if (error instanceof RangeError) return text("PAYLOAD_TOO_LARGE", 413)
      if (error instanceof InvalidPaymentWebhookRequestError) return text("INVALID_REQUEST", 400)
      if (error instanceof z.ZodError || error instanceof SyntaxError) return text("INVALID_REQUEST", 400)
      return text("INTERNAL_ERROR", 500)
    }
  }
}

let runtimeDependencies: Dependencies | undefined

function defaults() {
  if (runtimeDependencies) return runtimeDependencies
  const config = Resource.PaymentConfig
  const qpaySecrets = {
    merchantAccountID: Resource.QPayMerchantAccountID.value,
    clientID: Resource.QPayClientID.value,
    clientSecret: Resource.QPayClientSecret.value,
    invoiceCode: Resource.QPayInvoiceCode.value,
  }
  const bonumSecrets = {
    merchantAccountID: Resource.BonumMerchantAccountID.value,
    appSecret: Resource.BonumAppSecret.value,
    terminalID: Resource.BonumTerminalID.value,
    webhookChecksumKey: Resource.BonumWebhookChecksumKey.value,
  }
  const configured = (values: Record<string, string>) =>
    config.enabled && Object.values(values).every((value) => value && value !== "disabled")

  const qpay = configured(qpaySecrets)
    ? new QPayAdapter({
        environment: config.environment,
        ...qpaySecrets,
        invoiceCallbackURL: `${config.callbackBaseURL}/v1/webhooks/qpay`,
        timeoutMs: 8_000,
      })
    : undefined
  const bonum = configured(bonumSecrets)
    ? new BonumAdapter({
        environment: config.environment,
        ...bonumSecrets,
        invoiceCallbackURL: `${config.callbackBaseURL}/v1/webhooks/bonum`,
        providers: config.bonumProviders,
        timeoutMs: 8_000,
      })
    : undefined

  runtimeDependencies = {
    qpay: qpay ? (input) => reconcileQPayCallback(input, { adapter: qpay }) : undefined,
    bonum: bonum ? (input) => verifyBonumWebhook(input, { adapter: bonum }) : undefined,
    async enqueue(events) {
      await Resource.PaymentQueue.sendBatch(events.map((body) => ({ body })))
    },
  }
  return runtimeDependencies
}

export default {
  fetch(request: Request) {
    return createPaymentWebhookHandler(defaults())(request)
  },
}
